<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\MaintenanceTicket;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use App\Models\VehicleConditionCheck;
use App\Models\VehicleIssueReport;
use App\Models\VehicleHub;
use App\Models\VehicleLocation;
use App\Models\VehicleMaintenanceRecord;
use App\Models\VehicleMaintenanceSchedule;
use App\Models\VehicleReadinessCheck;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * FLEET INTELLIGENCE — the four consultant gaps:
 *   1. Readiness/coverage by vehicle type
 *   2. Preventive maintenance with teeth (overdue PM surfaced)
 *   3. Reliability / repeat-failure detection
 *   4. Decommission (end-of-life) lifecycle
 */
class FleetIntelligenceTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin', 'roles' => ['Admin']]);
        $this->custodian = User::factory()->create(['role' => 'Custodian', 'roles' => ['Custodian']]);
    }

    private function vehicle(string $categoryName = 'Ambulance', array $overrides = []): Vehicle
    {
        $category = VehicleCategory::create(['category_name' => $categoryName . ' ' . uniqid(), 'description' => 'x']);

        return Vehicle::create(array_merge([
            'vehicle_name' => $categoryName . ' Unit',
            'plate_number' => 'TST ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '12 pax', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ], $overrides));
    }

    // ---- Gap 1: Readiness / coverage -------------------------------------

    #[Test]
    public function readiness_flags_zero_coverage_when_the_only_unit_of_a_type_is_down(): void
    {
        $ambulance = $this->vehicle('Ambulance');
        $ambulance->update(['status' => 'Under Maintenance']); // the only ambulance is out

        Sanctum::actingAs($this->admin, ['*']);
        $readiness = collect($this->getJson('/api/dashboard')->assertOk()->json('readiness'));

        $row = $readiness->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertNotNull($row);
        $this->assertSame(0, $row['ready']);
        $this->assertSame(1, $row['total']);
        $this->assertTrue($row['no_coverage']);
    }

    #[Test]
    public function readiness_shows_coverage_when_a_ready_unit_exists(): void
    {
        $category = VehicleCategory::create(['category_name' => 'Fire Truck ' . uniqid(), 'description' => 'x']);
        $this->vehicle('Fire Truck', ['category_id' => $category->category_id]); // Available by default
        $down = $this->vehicle('Fire Truck', ['category_id' => $category->category_id]);
        $down->update(['status' => 'Under Maintenance']);

        Sanctum::actingAs($this->admin, ['*']);
        $readiness = collect($this->getJson('/api/dashboard')->assertOk()->json('readiness'));
        $row = $readiness->firstWhere('category', $category->category_name);

        $this->assertSame(1, $row['ready']);
        $this->assertSame(2, $row['total']);
        $this->assertFalse($row['no_coverage']);
    }

    // ---- Gap 2: Preventive maintenance with teeth ------------------------

    #[Test]
    public function an_overdue_preventive_schedule_surfaces_on_the_watch_list(): void
    {
        $vehicle = $this->vehicle();
        VehicleMaintenanceSchedule::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Oil Change',
            'scheduled_date' => now()->subDays(10)->toDateString(),
            'status' => 'Scheduled',
            'created_by' => $this->admin->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $watch = collect($this->getJson('/api/dashboard')->assertOk()->json('preventive_watch'));

        $row = $watch->firstWhere('vehicle_id', $vehicle->vehicle_id);
        $this->assertNotNull($row, 'Overdue PM should appear on the preventive watch list.');
        $this->assertSame('overdue', $row['state']);
    }

    // ---- Gap 3: Reliability / repeat-failure -----------------------------

    #[Test]
    public function a_repeat_ticket_for_the_same_issue_is_stamped_as_recurring(): void
    {
        $vehicle = $this->vehicle();

        // A previously fixed-and-closed "Overheating" ticket, recently closed.
        MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'was fixed before',
            'priority' => 'High',
            'status' => 'Closed',
            'closed_at' => now(),
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => "it's back",
            'priority' => 'High',
            'sub_issues' => [['title' => "it's back"]],
        ])->assertCreated();

        $this->assertSame(1, $response->json('recurrence_count'));
    }

    #[Test]
    public function a_ticket_opened_long_ago_but_closed_recently_still_counts_as_a_recurrence(): void
    {
        $vehicle = $this->vehicle();

        // Opened 120 days ago (outside the 90-day window) but only closed 5
        // days ago (a long repair delay) — it was JUST fixed, so it should
        // still count. Keying off when it opened would miss this.
        $prior = MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'took forever to fix',
            'priority' => 'High',
            'status' => 'Closed',
            'closed_at' => now()->subDays(5),
        ]);
        $prior->forceFill(['created_at' => now()->subDays(120)])->save();

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => "it's back again",
            'priority' => 'High',
            'sub_issues' => [['title' => "it's back again"]],
        ])->assertCreated();

        $this->assertSame(1, $response->json('recurrence_count'));
    }

    #[Test]
    public function a_ticket_opened_recently_but_closed_over_90_days_ago_does_not_count(): void
    {
        $vehicle = $this->vehicle();

        // Edge case guard: a ticket genuinely closed long ago shouldn't count
        // just because SQLite/Eloquent happened to touch created_at recently.
        MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'fixed a long time ago',
            'priority' => 'High',
            'status' => 'Closed',
            'closed_at' => now()->subDays(200),
        ]);

        Sanctum::actingAs($this->custodian, ['*']);
        $response = $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => "it's back",
            'priority' => 'High',
            'sub_issues' => [['title' => "it's back"]],
        ])->assertCreated();

        $this->assertSame(0, $response->json('recurrence_count'));
    }

    #[Test]
    public function the_reliability_endpoint_reports_per_vehicle_stats(): void
    {
        $vehicle = $this->vehicle();
        MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Engine Problem',
            'ticket_description' => 'x',
            'priority' => 'High',
            'status' => 'Closed',
            'closed_at' => now(),
        ]);
        VehicleMaintenanceRecord::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'maintenance_type' => 'Engine Repair',
            'problem_reason' => 'x',
            'maintenance_personnel_id' => $this->admin->id,
            'progress_status' => 'Completed',
            'maintenance_cost' => 1500,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $stats = $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/reliability")->assertOk()->json();

        $this->assertSame(1, $stats['failures_12mo']);
        $this->assertEqualsWithDelta(1500, $stats['total_spend'], 0.01);
        $this->assertArrayHasKey('chronic', $stats);
    }

    // ---- Gap 4: Decommission lifecycle -----------------------------------

    #[Test]
    public function an_admin_can_decommission_a_vehicle_with_a_reason(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        // Reason is mandatory.
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/decommission", [])->assertUnprocessable();

        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/decommission", [
            'decommission_reason' => 'Beyond economical repair — engine block cracked.',
        ])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Decommissioned', $vehicle->status);
        $this->assertSame($this->admin->id, $vehicle->decommissioned_by);
        $this->assertNotNull($vehicle->decommissioned_at);
    }

    #[Test]
    public function decommissioning_is_blocked_while_a_ticket_is_still_open(): void
    {
        $vehicle = $this->vehicle();
        MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'created_by' => $this->admin->id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'status' => 'Active',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/decommission", [
            'decommission_reason' => 'retiring it',
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_decommissioned_vehicle_is_removed_from_the_ticketable_fleet(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update(['status' => 'Decommissioned']);

        Sanctum::actingAs($this->admin, ['*']);
        // Not offered in the ticket lookups...
        $ids = collect($this->getJson('/api/tickets/lookups')->json('vehicles'))->pluck('vehicle_id');
        $this->assertFalse($ids->contains($vehicle->vehicle_id));

        // ...and can't be ticketed directly.
        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson('/api/tickets/propose', [
            'vehicle_id' => $vehicle->vehicle_id,
            'ticket_title' => 'Overheating',
            'ticket_description' => 'x',
            'priority' => 'High',
            'sub_issues' => [['title' => 'x']],
        ])->assertUnprocessable();
    }

    #[Test]
    public function a_decommissioned_vehicle_no_longer_counts_toward_needs_attention(): void
    {
        $vehicle = $this->vehicle();
        // A real repair need before retirement...
        VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
            'checked_by' => $this->custodian->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $before = $this->getJson('/api/dashboard')->assertOk()->json('badge_counts.conditions');
        $this->assertGreaterThanOrEqual(1, $before);

        // ...decommissioning sets condition to Needs Repair, but the vehicle
        // is retired — it shouldn't keep inflating "needs attention" forever.
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/decommission", [
            'decommission_reason' => 'Beyond economical repair.',
        ])->assertOk();

        $after = $this->getJson('/api/dashboard')->assertOk()->json('badge_counts.conditions');
        $this->assertSame($before - 1, $after);
    }

    #[Test]
    public function restore_recommissions_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update([
            'status' => 'Decommissioned',
            'decommission_reason' => 'mistake',
            'decommissioned_by' => $this->admin->id,
            'decommissioned_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson("/api/vehicles/{$vehicle->vehicle_id}/restore")->assertOk();

        $vehicle->refresh();
        $this->assertSame('Available', $vehicle->status);
        $this->assertNull($vehicle->decommissioned_at);
    }

    // ---- Gap A: Readiness checks ("ready to respond") --------------------

    #[Test]
    public function an_available_but_unchecked_vehicle_is_not_verified_ready(): void
    {
        $ambulance = $this->vehicle('Ambulance'); // Available, never checked

        Sanctum::actingAs($this->admin, ['*']);
        $dash = $this->getJson('/api/dashboard')->assertOk();

        $readinessRow = collect($dash->json('readiness'))->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertSame(1, $readinessRow['ready']);          // available
        $this->assertSame(0, $readinessRow['verified_ready']); // but not verified

        $watch = collect($dash->json('readiness_watch'))->firstWhere('vehicle_id', $ambulance->vehicle_id);
        $this->assertNotNull($watch);
        $this->assertSame('unchecked', $watch['state']);
    }

    #[Test]
    public function a_passing_readiness_check_makes_the_vehicle_verified_ready(): void
    {
        $ambulance = $this->vehicle('Ambulance');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/vehicles/{$ambulance->vehicle_id}/readiness-check", [
            'checklist' => [
                ['item' => 'Fuel full', 'passed' => true],
                ['item' => 'Oxygen present', 'passed' => true],
                ['item' => 'Lights & siren work', 'passed' => true],
            ],
        ])->assertCreated();

        Sanctum::actingAs($this->admin, ['*']);
        $dash = $this->getJson('/api/dashboard')->assertOk();

        $row = collect($dash->json('readiness'))->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertSame(1, $row['verified_ready']);

        // No longer on the readiness watch list.
        $watch = collect($dash->json('readiness_watch'))->firstWhere('vehicle_id', $ambulance->vehicle_id);
        $this->assertNull($watch);
    }

    #[Test]
    public function a_failed_readiness_check_flags_the_vehicle_not_ready(): void
    {
        $ambulance = $this->vehicle('Ambulance');

        Sanctum::actingAs($this->custodian, ['*']);
        $this->postJson("/api/vehicles/{$ambulance->vehicle_id}/readiness-check", [
            'checklist' => [
                ['item' => 'Fuel full', 'passed' => false], // empty tank
                ['item' => 'Oxygen present', 'passed' => true],
            ],
        ])->assertCreated();

        $state = $this->getJson("/api/vehicles/{$ambulance->vehicle_id}/readiness")->assertOk()->json('state');
        $this->assertSame('not_ready', $state);
    }

    // ---- Gap B: Single-point-of-failure ----------------------------------

    #[Test]
    public function a_type_with_a_single_unit_is_flagged_as_a_single_point_of_failure(): void
    {
        $ambulance = $this->vehicle('Ambulance'); // exactly one

        Sanctum::actingAs($this->admin, ['*']);
        $fragility = collect($this->getJson('/api/dashboard')->assertOk()->json('fragility'));

        $row = $fragility->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertNotNull($row);
        $this->assertTrue($row['single_point']);
        $this->assertSame(1, $row['operational']);
    }

    #[Test]
    public function a_type_with_several_units_but_only_one_ready_is_also_a_single_point_of_failure(): void
    {
        // 3 ambulances total — 2 are in the shop, only 1 is actually ready to
        // respond. That's exactly the "one breakdown from zero coverage" risk,
        // even though the category has more than one unit on paper.
        $ambulance = $this->vehicle('Ambulance');
        $this->vehicle('Ambulance', ['category_id' => $ambulance->category_id, 'status' => 'Under Maintenance']);
        $this->vehicle('Ambulance', ['category_id' => $ambulance->category_id, 'status' => 'Under Maintenance']);

        Sanctum::actingAs($this->admin, ['*']);
        $fragility = collect($this->getJson('/api/dashboard')->assertOk()->json('fragility'));

        $row = $fragility->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertNotNull($row);
        $this->assertSame(3, $row['operational']);
        $this->assertSame(1, $row['ready']);
        $this->assertTrue($row['single_point']);
        $this->assertFalse($row['critical'], 'Not critical yet — one unit is still ready.');
    }

    #[Test]
    public function a_type_with_zero_ready_units_is_flagged_critical(): void
    {
        $ambulance = $this->vehicle('Ambulance', ['status' => 'Under Maintenance']);
        $this->vehicle('Ambulance', ['category_id' => $ambulance->category_id, 'status' => 'Under Maintenance']);

        Sanctum::actingAs($this->admin, ['*']);
        $fragility = collect($this->getJson('/api/dashboard')->assertOk()->json('fragility'));

        $row = $fragility->firstWhere('category', $ambulance->fresh()->category->category_name);
        $this->assertNotNull($row);
        $this->assertSame(0, $row['ready']);
        $this->assertTrue($row['single_point']);
        $this->assertTrue($row['critical']);
    }

    // ---- Gap C: Fleet-wide failure patterns ------------------------------

    #[Test]
    public function failure_patterns_rank_the_most_common_maintenance_type(): void
    {
        $vehicle = $this->vehicle();
        foreach (['Brake Repair', 'Brake Repair', 'Engine Repair'] as $type) {
            VehicleMaintenanceRecord::create([
                'vehicle_id' => $vehicle->vehicle_id,
                'maintenance_type' => $type,
                'problem_reason' => 'x',
                'maintenance_personnel_id' => $this->admin->id,
                'progress_status' => 'Completed',
                'maintenance_cost' => 100,
            ]);
        }

        Sanctum::actingAs($this->admin, ['*']);
        $patterns = collect($this->getJson('/api/dashboard')->assertOk()->json('failure_patterns'));

        $this->assertSame('Brake Repair', $patterns->first()['type']);
        $this->assertSame(2, $patterns->first()['count']);
    }

    // ---- Regression: resolving an issue report must not un-retire a vehicle -

    #[Test]
    public function resolving_an_issue_report_does_not_reactivate_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update([
            'status' => 'Decommissioned',
            'condition' => 'Needs Repair',
            'decommission_reason' => 'retired',
            'decommissioned_by' => $this->admin->id,
            'decommissioned_at' => now(),
        ]);

        // An old issue report filed before the vehicle was retired.
        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Engine Problem',
            'issue_description' => 'x',
            'severity_level' => 'Low',
            'reported_by' => $this->custodian->id,
            'status' => 'Pending',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}", ['status' => 'Resolved'])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Decommissioned', $vehicle->status, 'A retired vehicle must stay retired.');
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    #[Test]
    public function resolving_an_issue_report_still_updates_an_active_vehicle(): void
    {
        $vehicle = $this->vehicle(overrides: ['status' => 'Under Maintenance', 'condition' => 'Needs Repair']);

        $issue = VehicleIssueReport::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'issue_type' => 'Engine Problem',
            'issue_description' => 'x',
            'severity_level' => 'Low',
            'reported_by' => $this->custodian->id,
            'status' => 'In Maintenance',
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/issues/{$issue->issue_report_id}", ['status' => 'Resolved'])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Available', $vehicle->status);
        $this->assertSame('Good', $vehicle->condition);
    }

    // ---- Regression: mark-available needs server-side proof ---------------

    #[Test]
    public function mark_available_is_blocked_without_any_readiness_check(): void
    {
        $vehicle = $this->vehicle();

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/mark-available")->assertUnprocessable();

        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    #[Test]
    public function mark_available_is_blocked_when_the_latest_readiness_check_failed(): void
    {
        $vehicle = $this->vehicle(overrides: ['status' => 'Under Maintenance']);
        VehicleReadinessCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'checked_by' => $this->custodian->id,
            'checklist' => [['item' => 'Fuel full', 'passed' => false]],
            'all_passed' => false,
            'checked_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/mark-available")->assertUnprocessable();

        $this->assertSame('Under Maintenance', $vehicle->fresh()->status);
    }

    #[Test]
    public function a_passing_readiness_check_overrides_a_lingering_needs_repair_condition(): void
    {
        // Emergency-dispatch case: a minor outstanding repair shouldn't
        // block a vehicle from responding if it's physically confirmed
        // ready right now — the readiness check is what decides that, not
        // the separate condition label.
        $vehicle = $this->vehicle(overrides: ['status' => 'Under Maintenance', 'condition' => 'Needs Repair']);
        VehicleReadinessCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'checked_by' => $this->custodian->id,
            'checklist' => [['item' => 'Fuel full', 'passed' => true]],
            'all_passed' => true,
            'checked_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/mark-available")->assertOk();

        $vehicle->refresh();
        $this->assertSame('Available', $vehicle->status);
        // The condition label is left alone — the repair is still real and
        // still outstanding, it just isn't what's blocking dispatch now.
        $this->assertSame('Needs Repair', $vehicle->condition);

        // "Ready to Respond" reflects the passing check, not the lingering
        // condition flag, now that the vehicle is Available again.
        $readiness = $this->getJson("/api/vehicles/{$vehicle->vehicle_id}/readiness")->assertOk();
        $this->assertSame('ready', $readiness->json('state'));
    }

    #[Test]
    public function mark_available_succeeds_after_a_passing_readiness_check(): void
    {
        $vehicle = $this->vehicle(overrides: ['status' => 'Under Maintenance', 'condition' => 'Good']);
        VehicleReadinessCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'checked_by' => $this->custodian->id,
            'checklist' => [['item' => 'Fuel full', 'passed' => true]],
            'all_passed' => true,
            'checked_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}/mark-available")->assertOk();

        $this->assertSame('Available', $vehicle->fresh()->status);
    }

    // ---- Regression: shared VehicleCategory can't be deleted cross-tenant --

    #[Test]
    public function a_category_still_used_by_another_barangays_vehicle_cannot_be_deleted(): void
    {
        $otherBarangay = Barangay::create(['name' => 'Other Barangay ' . uniqid()]);
        $category = VehicleCategory::create(['category_name' => 'Shared Type ' . uniqid(), 'description' => 'x']);

        // A vehicle owned by a DIFFERENT barangay uses this category. The
        // current admin's own (barangay-scoped) view of Vehicle sees none of
        // it, but the shared vehicle_categories row is still referenced.
        Vehicle::create([
            'vehicle_name' => 'Other Barangay Unit',
            'plate_number' => 'OTH ' . random_int(1000, 9999),
            'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022,
            'capacity' => '12 pax', 'vehicle_color' => 'White', 'current_location' => 'Main Depot',
            'barangay_id' => $otherBarangay->id,
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/categories/{$category->category_id}")->assertUnprocessable();

        $this->assertDatabaseHas('vehicle_categories', ['category_id' => $category->category_id]);
    }

    // ---- Regression: condition checks must not un-decommission a vehicle --

    #[Test]
    public function storing_a_condition_check_does_not_reactivate_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $vehicle->update([
            'status' => 'Decommissioned',
            'condition' => 'Needs Repair',
            'decommission_reason' => 'retired',
            'decommissioned_by' => $this->admin->id,
            'decommissioned_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/conditions', [
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
        ])->assertCreated();

        $vehicle->refresh();
        $this->assertSame('Decommissioned', $vehicle->status, 'A retired vehicle must stay retired.');
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    #[Test]
    public function updating_a_condition_check_does_not_reactivate_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
            'checked_by' => $this->custodian->id,
        ]);

        $vehicle->update([
            'status' => 'Decommissioned',
            'condition' => 'Needs Repair',
            'decommission_reason' => 'retired',
            'decommissioned_by' => $this->admin->id,
            'decommissioned_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/conditions/{$condition->condition_check_id}", [
            'condition_result' => 'Good',
        ])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Decommissioned', $vehicle->status, 'A retired vehicle must stay retired.');
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    #[Test]
    public function deleting_a_condition_check_does_not_reactivate_a_decommissioned_vehicle(): void
    {
        $vehicle = $this->vehicle();
        $condition = VehicleConditionCheck::create([
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Good',
            'checked_by' => $this->custodian->id,
        ]);

        $vehicle->update([
            'status' => 'Decommissioned',
            'condition' => 'Needs Repair',
            'decommission_reason' => 'retired',
            'decommissioned_by' => $this->admin->id,
            'decommissioned_at' => now(),
        ]);

        Sanctum::actingAs($this->admin, ['*']);
        $this->deleteJson("/api/conditions/{$condition->condition_check_id}")->assertOk();

        $vehicle->refresh();
        $this->assertSame('Decommissioned', $vehicle->status, 'A retired vehicle must stay retired.');
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    #[Test]
    public function a_condition_check_still_updates_an_active_vehicle(): void
    {
        $vehicle = $this->vehicle(overrides: ['status' => 'Available', 'condition' => 'Good']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson('/api/conditions', [
            'vehicle_id' => $vehicle->vehicle_id,
            'condition_result' => 'Needs Repair',
        ])->assertCreated();

        $vehicle->refresh();
        $this->assertSame('Under Maintenance', $vehicle->status);
        $this->assertSame('Needs Repair', $vehicle->condition);
    }

    // ---- Regression: editing a vehicle's location via PUT must be logged --

    #[Test]
    public function updating_a_vehicles_current_location_via_put_creates_a_location_history_row(): void
    {
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9]);
        VehicleHub::create(['hub_key' => 'sub-station', 'name' => 'Sub Station', 'label' => 'SS', 'lat' => 10.4, 'lng' => 123.8]);

        $vehicle = $this->vehicle(overrides: ['current_location' => 'Main Depot']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}", [
            'vehicle_name' => $vehicle->vehicle_name,
            'plate_number' => $vehicle->plate_number,
            'category_id' => $vehicle->category_id,
            'brand' => $vehicle->brand,
            'model' => $vehicle->model,
            'year_model' => $vehicle->year_model,
            'capacity' => $vehicle->capacity,
            'fuel_type' => 'Diesel',
            'vehicle_color' => $vehicle->vehicle_color,
            'current_location' => 'Sub Station',
        ])->assertOk();

        $vehicle->refresh();
        $this->assertSame('Sub Station', $vehicle->current_location);
        $this->assertDatabaseHas('vehicle_locations', [
            'vehicle_id' => $vehicle->vehicle_id,
            'current_location' => 'Sub Station',
        ]);
        $this->assertSame(1, VehicleLocation::where('vehicle_id', $vehicle->vehicle_id)->count());
    }

    #[Test]
    public function updating_a_vehicle_without_changing_its_location_creates_no_location_row(): void
    {
        VehicleHub::create(['hub_key' => 'main-depot', 'name' => 'Main Depot', 'label' => 'MD', 'lat' => 10.3, 'lng' => 123.9]);

        $vehicle = $this->vehicle(overrides: ['current_location' => 'Main Depot']);

        Sanctum::actingAs($this->admin, ['*']);
        $this->putJson("/api/vehicles/{$vehicle->vehicle_id}", [
            'vehicle_name' => $vehicle->vehicle_name,
            'plate_number' => $vehicle->plate_number,
            'category_id' => $vehicle->category_id,
            'brand' => $vehicle->brand,
            'model' => $vehicle->model,
            'year_model' => $vehicle->year_model,
            'capacity' => $vehicle->capacity,
            'fuel_type' => 'Diesel',
            'vehicle_color' => $vehicle->vehicle_color,
            'current_location' => 'Main Depot',
        ])->assertOk();

        $this->assertDatabaseCount('vehicle_locations', 0);
    }
}
