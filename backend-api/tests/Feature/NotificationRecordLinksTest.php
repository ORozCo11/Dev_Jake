<?php

namespace Tests\Feature;

use App\Models\Notification;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceSchedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Production-readiness audit finding #10 — issue-report and schedule
 * notifications previously carried no link to what they were about, so
 * clicking one just marked it read and left the user wherever they were.
 * These prove the new issue_report_id/schedule_id columns are actually
 * populated by the controller, which is what the frontend click handler
 * now reads to navigate to the right record.
 */
class NotificationRecordLinksTest extends TestCase
{
    use RefreshDatabase;

    private function vehicle(): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => 'Ambulance ' . uniqid(), 'description' => 'x']);

        return Vehicle::create([
            'vehicle_name' => 'Test Ambulance',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '1000 kg', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);
    }

    #[Test]
    public function filing_an_issue_report_notifies_admins_with_a_link_to_it(): void
    {
        $vehicle = $this->vehicle();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $vehicle->barangay_id]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian'], 'barangay_id' => $vehicle->barangay_id]);

        Sanctum::actingAs($custodian, ['*']);
        $issue = $this->postJson('/api/issues', [
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Flat tire',
            'issue_description' => 'Front-left tire flat.',
            'severity_level' => 'Low',
        ])->assertCreated()->json();

        $notification = Notification::where('user_id', $admin->id)->where('type', 'issue_reported')->firstOrFail();
        $this->assertSame($issue['issue_report_id'], $notification->issue_report_id);
        $this->assertNull($notification->ticket_id);
    }

    #[Test]
    public function assigning_a_schedule_notifies_the_mechanic_with_a_link_to_it(): void
    {
        $vehicle = $this->vehicle();
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin'], 'barangay_id' => $vehicle->barangay_id]);
        $mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel'], 'barangay_id' => $vehicle->barangay_id]);
        $schedule = VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->addWeek()->toDateString(),
            'created_by' => $admin->id,
            'status' => 'Scheduled',
        ]);

        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/maintenance-schedules/{$schedule->schedule_id}/reassign", [
            'assigned_to' => $mechanic->id,
        ])->assertOk();

        $notification = Notification::where('user_id', $mechanic->id)->where('type', 'schedule_assigned')->firstOrFail();
        $this->assertSame($schedule->schedule_id, $notification->schedule_id);
    }
}
