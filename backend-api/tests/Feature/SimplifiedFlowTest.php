<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleMaintenanceRecord;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The whole simplified process, end to end:
 * Custodian proposes -> Admin approves and assigns -> Maintenance repairs ->
 * Custodian verifies, which closes the ticket -> the system updates history,
 * the maintenance record and the vehicle on its own.
 */
class SimplifiedFlowTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function one_problem_goes_from_proposal_to_closed_with_four_actions(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $mechanic = User::factory()->create(['role' => 'Maintenance Personnel', 'roles' => ['Maintenance Personnel']]);
        $category = VehicleCategory::create(['category_name' => 'Ambulance', 'description' => 'x']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Amb One', 'plate_number' => 'AMB 1234', 'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022, 'capacity' => '8', 'vehicle_color' => 'White',
            'current_location' => 'Main Depot', 'status' => 'Available', 'condition' => 'Good',
        ]);

        // 1. Custodian proposes (the problem is the form — there is no separate issue report).
        Sanctum::actingAs($custodian, ['*']);
        $id = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id, 'ticket_description' => 'Brake pedal feels soft.', 'priority' => 'High',
            'sub_issues' => [['title' => 'Brake failure', 'maintenance_type' => 'Brake System']],
        ])->assertCreated()->json('ticket_id');
        $this->assertSame('Pending Approval', MaintenanceTicket::find($id)->status);
        $this->assertSame('Available', $vehicle->fresh()->status); // nothing changes until Admin approves

        // 2. Admin approves and assigns in one step.
        Sanctum::actingAs($admin, ['*']);
        $this->putJson("/api/tickets/{$id}/approve", ['assigned_mechanic_id' => $mechanic->id])->assertOk();
        $ticket = MaintenanceTicket::find($id);
        $job = $ticket->subIssues->first();
        $this->assertSame('Active', $ticket->status);
        $this->assertSame('Under Repair', $job->status);
        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);

        // 3. Maintenance does the work.
        Sanctum::actingAs($mechanic, ['*']);
        $this->putJson("/api/tickets/{$id}/sub-issues/{$job->sub_issue_id}/log-repairs", ['repair_logs' => 'Replaced pads and bled the lines.'])->assertOk();

        // 4. Custodian verifies — that is also the close.
        Sanctum::actingAs($custodian, ['*']);
        $this->putJson("/api/tickets/{$id}/sub-issues/{$job->sub_issue_id}/verify", [
            'verification_verdict' => 'Approved', 'test_attested' => true,
            'functional_test' => [['item' => 'Brakes respond', 'passed' => true]],
        ])->assertOk();

        $this->assertSame('Closed', MaintenanceTicket::find($id)->status);
        $this->assertSame('Done', $job->fresh()->status);
        $this->assertSame('Available', $vehicle->fresh()->status);
        $this->assertSame('Good', $vehicle->fresh()->condition);

        // The system wrote the rest on its own.
        $this->assertSame(1, VehicleMaintenanceRecord::where('vehicle_id', $vehicle->vehicle_id)->count());
        $this->assertDatabaseHas('vehicle_histories', ['vehicle_id' => $vehicle->vehicle_id, 'activity_type' => 'Ticket Approved']);
        $this->assertDatabaseHas('activity_logs', ['action' => 'Ticket Closed']);
        $this->assertDatabaseHas('notifications', ['user_id' => $admin->id, 'type' => 'ticket_closed']);
    }

    #[Test]
    public function a_second_problem_needs_a_second_ticket(): void
    {
        $custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
        $category = VehicleCategory::create(['category_name' => 'Ambulance', 'description' => 'x']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Amb One', 'plate_number' => 'AMB 1234', 'category_id' => $category->category_id,
            'brand' => 'T', 'model' => 'T', 'year_model' => 2022, 'capacity' => '8', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);

        Sanctum::actingAs($custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id, 'ticket_description' => 'x', 'priority' => 'Low',
            'sub_issues' => [['title' => 'Brakes'], ['title' => 'Radiator']],
        ])->assertUnprocessable();
    }
}
