<?php

namespace Tests\Feature;

use App\Models\MaintenanceTicket;
use App\Models\TicketSubIssue;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleCategory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Phase 4: add/edit/delete a not-yet-dispatched sub-issue, cannibalization
 * part details, and the external send -> return stages.
 */
class SpecPhase4SubIssuesTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $custodian;
    private User $otherCustodian;
    private User $mechanic;
    private MaintenanceTicket $ticket;
    private TicketSubIssue $sub;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'Admin']);
        $this->custodian = User::factory()->create(['role' => 'Custodian']);
        $this->otherCustodian = User::factory()->create(['role' => 'Custodian']);
        $this->mechanic = User::factory()->create(['role' => 'Maintenance Personnel']);

        $category = VehicleCategory::create(['category_name' => 'Ambulance', 'description' => 'x']);
        $vehicle = Vehicle::create([
            'vehicle_name' => 'Amb One', 'plate_number' => 'TST 1234', 'category_id' => $category->category_id,
            'brand' => 'Toyota', 'model' => 'HiAce', 'year_model' => 2022, 'capacity' => '1000 kg',
            'vehicle_color' => 'White', 'current_location' => 'Main Depot',
        ]);
        $this->ticket = MaintenanceTicket::create([
            'vehicle_id' => $vehicle->vehicle_id, 'created_by' => $this->admin->id, 'ticket_title' => 'Overheating',
            'ticket_description' => 'x', 'priority' => 'High', 'status' => 'Active',
            'assigned_custodian_id' => $this->custodian->id, 'assigned_at' => now(),
        ]);
        $this->sub = TicketSubIssue::create(['ticket_id' => $this->ticket->ticket_id, 'created_by' => $this->custodian->id, 'title' => 'Low coolant', 'status' => 'Open']);
    }

    private function url(string $suffix = ''): string
    {
        return "/api/tickets/{$this->ticket->ticket_id}/sub-issues" . $suffix;
    }

    private function dispatchTo(TicketSubIssue $sub, array $extra = []): void
    {
        $sub->update(['status' => 'Under Repair', 'assigned_mechanic_id' => $this->mechanic->id] + $extra);
    }

    #[Test]
    public function admin_and_the_assigned_custodian_can_add_edit_and_delete_an_open_sub_issue(): void
    {
        foreach ([$this->admin, $this->custodian] as $user) {
            Sanctum::actingAs($user, ['*']);
            $id = $this->postJson($this->url(), ['title' => 'Radiator leak'])->assertCreated()->json('sub_issue_id');
            $this->putJson($this->url("/{$id}"), ['title' => 'Radiator hose leak'])->assertOk()->assertJsonPath('title', 'Radiator hose leak');
            $this->deleteJson($this->url("/{$id}"))->assertOk();
        }
        $this->assertDatabaseCount('ticket_sub_issues', 1);
    }

    #[Test]
    public function other_roles_and_other_custodians_cannot_change_sub_issues(): void
    {
        foreach ([$this->mechanic, $this->otherCustodian] as $user) {
            Sanctum::actingAs($user, ['*']);
            $this->postJson($this->url(), ['title' => 'Nope'])->assertForbidden();
        }
    }

    #[Test]
    public function a_dispatched_sub_issue_cannot_be_edited_or_removed_and_the_last_one_stays(): void
    {
        Sanctum::actingAs($this->admin, ['*']);
        $this->dispatchTo($this->sub);
        $this->putJson($this->url("/{$this->sub->sub_issue_id}"), ['title' => 'x'])->assertUnprocessable();
        $this->deleteJson($this->url("/{$this->sub->sub_issue_id}"))->assertUnprocessable();

        $open = TicketSubIssue::create(['ticket_id' => $this->ticket->ticket_id, 'created_by' => $this->admin->id, 'title' => 'Second', 'status' => 'Open']);
        $this->deleteJson($this->url("/{$open->sub_issue_id}"))->assertOk();

        $this->sub->update(['status' => 'Open', 'assigned_mechanic_id' => null]);
        $this->deleteJson($this->url("/{$this->sub->sub_issue_id}"))->assertUnprocessable(); // last remaining
    }

    #[Test]
    public function sub_issues_cannot_change_once_the_ticket_is_no_longer_active(): void
    {
        $this->ticket->update(['status' => 'Closed']);
        Sanctum::actingAs($this->admin, ['*']);
        $this->postJson($this->url(), ['title' => 'Late'])->assertUnprocessable();
    }

    #[Test]
    public function a_cannibalized_repair_stores_the_part_details(): void
    {
        $category = VehicleCategory::first();
        $donor = Vehicle::create([
            'vehicle_name' => 'Donor', 'plate_number' => 'DON 1234', 'category_id' => $category->category_id, 'brand' => 'T', 'model' => 'T',
            'year_model' => 2020, 'capacity' => '1', 'vehicle_color' => 'x', 'current_location' => 'Main Depot',
        ]);
        $this->dispatchTo($this->sub);

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson($this->url("/{$this->sub->sub_issue_id}/log-repairs"), [
            'repair_logs' => 'Swapped radiator.', 'repair_type' => 'cannibalized', 'source_vehicle_id' => $donor->vehicle_id,
            'part_needed' => 'Radiator', 'part_quantity' => 1, 'part_condition' => 'Good, lightly used',
            'cannibal_reason' => 'Supplier backordered 3 weeks.', 'part_installed_at' => '2026-10-07',
        ])->assertOk();

        $fresh = $this->sub->fresh();
        $this->assertSame(1, $fresh->part_quantity);
        $this->assertSame('Good, lightly used', $fresh->part_condition);
        $this->assertSame('2026-10-07', $fresh->part_installed_at->toDateString());
    }

    #[Test]
    public function an_external_repair_must_be_sent_then_returned_before_it_can_be_submitted(): void
    {
        $this->dispatchTo($this->sub);
        $url = $this->url("/{$this->sub->sub_issue_id}");

        Sanctum::actingAs($this->mechanic, ['*']);
        $this->putJson("{$url}/external-returned", ['external_return_notes' => 'x'])->assertUnprocessable(); // never sent
        $this->putJson("{$url}/external-sent", ['external_vendor' => 'Joe Auto'])->assertUnprocessable();    // missing reason/scope

        $this->putJson("{$url}/external-sent", [
            'external_vendor' => 'Joe Auto', 'external_reason' => 'No lift', 'external_work_scope' => 'Replace clutch', 'external_estimated_cost' => 5000,
        ])->assertOk()->assertJsonPath('repair_type', 'external');

        $this->putJson("{$url}/log-repairs", ['repair_logs' => 'Done by shop.'])->assertUnprocessable(); // still out
        $this->putJson("{$url}/external-sent", ['external_vendor' => 'x', 'external_reason' => 'x', 'external_work_scope' => 'x'])->assertUnprocessable();

        $this->putJson("{$url}/external-returned", ['external_return_notes' => 'Clutch replaced, tested.', 'external_actual_cost' => 4800])->assertOk();
        $this->putJson("{$url}/log-repairs", ['repair_logs' => 'Back from shop.'])->assertOk();
        $this->assertSame('For Inspection', $this->sub->fresh()->status);
    }

    #[Test]
    public function only_the_assigned_mechanic_can_send_or_return(): void
    {
        $this->dispatchTo($this->sub);
        $other = User::factory()->create(['role' => 'Maintenance Personnel']);
        Sanctum::actingAs($other, ['*']);
        $this->putJson($this->url("/{$this->sub->sub_issue_id}/external-sent"), ['external_vendor' => 'x', 'external_reason' => 'x', 'external_work_scope' => 'x'])->assertForbidden();
    }
}
