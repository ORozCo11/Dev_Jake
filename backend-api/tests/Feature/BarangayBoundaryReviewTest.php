<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Final stabilization (§33) — a boundary match from the public geocoder is
 * no longer auto-saved. It lands in `pending_boundary` for the Super Admin
 * to review on a map and explicitly confirm; `boundary` is only ever
 * written by confirmBarangayBoundary(). Also covers the geometry sanity
 * check that rejects a degenerate (too-short/unclosed) ring before it's
 * even offered for review.
 */
class BarangayBoundaryReviewTest extends TestCase
{
    use RefreshDatabase;

    private User $superAdmin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->superAdmin = User::factory()->create(['role' => 'Super Admin', 'roles' => ['Super Admin']]);
    }

    private function barangay(): Barangay
    {
        $province = Province::create(['code' => 'TST', 'name' => 'Test Province']);
        $city = City::create(['province_id' => $province->id, 'code' => 'TSTC', 'name' => 'Test City']);

        return Barangay::create(['name' => 'Test Barangay', 'city_id' => $city->id]);
    }

    private function validRing(): array
    {
        // A closed square — 4 distinct corners plus the repeated first point.
        return [[123.9, 10.3], [123.91, 10.3], [123.91, 10.31], [123.9, 10.31], [123.9, 10.3]];
    }

    private function nominatimResult(array $ring, string $barangayName = 'Test Barangay', string $cityName = 'Test City'): array
    {
        return [[
            'class' => 'boundary',
            'type' => 'administrative',
            'geojson' => ['type' => 'Polygon', 'coordinates' => [$ring]],
            'address' => ['city' => $cityName, 'village' => $barangayName],
        ]];
    }

    #[Test]
    public function a_found_match_lands_in_pending_not_boundary(): void
    {
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult($this->validRing()))]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('needs_review', $response->json('boundary_status'));
        $this->assertFalse($response->json('has_boundary'));

        $barangay->refresh();
        $this->assertNull($barangay->boundary, 'A found match must not be auto-saved to the live boundary.');
        $this->assertNotNull($barangay->pending_boundary);
        $this->assertSame('osm_nominatim', $barangay->pending_boundary_source);
    }

    #[Test]
    public function confirming_a_pending_boundary_moves_it_to_live_and_stamps_the_verifier(): void
    {
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult($this->validRing()))]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertOk();
        $this->assertSame('verified', $response->json('boundary_status'));

        $barangay->refresh();
        $this->assertNotNull($barangay->boundary);
        $this->assertSame('verified', $barangay->boundary_status);
        $this->assertSame('osm_nominatim', $barangay->boundary_source);
        $this->assertSame($this->superAdmin->id, $barangay->boundary_verified_by);
        $this->assertNotNull($barangay->boundary_verified_at);
        $this->assertNull($barangay->pending_boundary, 'The pending slot should be cleared once confirmed.');

        $this->assertDatabaseHas('activity_logs', [
            'module' => 'Super Admin',
            'action' => 'Edit',
        ]);
    }

    #[Test]
    public function confirming_with_nothing_pending_is_rejected(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/confirm")->assertStatus(422);
    }

    #[Test]
    public function discarding_a_pending_boundary_leaves_the_live_boundary_untouched(): void
    {
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult($this->validRing()))]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();
        $this->deleteJson("/api/superadmin/barangays/{$barangay->id}/boundary/pending")->assertOk();

        $barangay->refresh();
        $this->assertNull($barangay->pending_boundary);
        $this->assertNull($barangay->boundary);
        $this->assertSame('not_found', $barangay->boundary_status, 'Discarding with nothing confirmed before should read as not_found.');
    }

    #[Test]
    public function an_already_verified_boundary_is_never_touched_by_another_refresh(): void
    {
        $barangay = $this->barangay();
        $barangay->update([
            'boundary' => ['type' => 'Polygon', 'coordinates' => [$this->validRing()]],
            'boundary_status' => 'verified',
            'boundary_source' => 'legacy',
            'boundary_verified_at' => now(),
        ]);

        // A different geometry this time — if this were ever accepted, the
        // verified boundary would have silently changed underneath it.
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult([
            [124.0, 10.5], [124.01, 10.5], [124.01, 10.51], [124.0, 10.51], [124.0, 10.5],
        ]))]);

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();
        $this->assertTrue($response->json('has_boundary'));
        $this->assertSame('verified', $response->json('boundary_status'));

        $originalCoordinates = $barangay->boundary['coordinates'];
        $barangay->refresh();
        $this->assertSame($originalCoordinates, $barangay->boundary['coordinates'], 'An existing verified boundary must never change from a later lookup.');
        $this->assertNull($barangay->pending_boundary);
    }

    #[Test]
    public function no_match_sets_not_found(): void
    {
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response([])]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('not_found', $response->json('boundary_status'));
        $this->assertSame('not_found', $barangay->fresh()->boundary_status);
    }

    #[Test]
    public function a_degenerate_ring_is_rejected_before_it_ever_becomes_a_pending_candidate(): void
    {
        // Only 3 points (a valid closed ring needs at least 4, the last
        // repeating the first) — geometrically unusable.
        $tooShort = [[123.9, 10.3], [123.91, 10.3], [123.9, 10.3]];
        Http::fake(['nominatim.openstreetmap.org/*' => Http::response($this->nominatimResult($tooShort))]);
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $response = $this->postJson("/api/superadmin/barangays/{$barangay->id}/boundary/refresh")->assertOk();

        $this->assertSame('not_found', $response->json('boundary_status'), 'A degenerate ring must be treated as no usable match, not offered for review.');
        $this->assertNull($barangay->fresh()->pending_boundary);
    }

    #[Test]
    public function the_registration_code_response_includes_when_it_was_last_changed(): void
    {
        $barangay = $this->barangay();

        Sanctum::actingAs($this->superAdmin, ['*']);
        $first = $this->getJson("/api/superadmin/barangays/{$barangay->id}/registration-code")->assertOk();
        $this->assertNotNull($first->json('updated_at'));

        $second = $this->postJson("/api/superadmin/barangays/{$barangay->id}/registration-code/regenerate")->assertOk();
        $this->assertNotNull($second->json('updated_at'));
        $this->assertNotSame($first->json('staff_code'), $second->json('staff_code'));
    }
}
