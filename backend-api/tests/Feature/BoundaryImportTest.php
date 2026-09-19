<?php

namespace Tests\Feature;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * NATIONWIDE BOUNDARY IMPORT
 *
 * The importer reconciles upstream PSGC data against whatever barangays this
 * instance already has. The rows it touches are the ones users are registered
 * against, so the rules it must never break are: don't duplicate, don't
 * rename, don't delete, don't orphan.
 */
class BoundaryImportTest extends TestCase
{
    use RefreshDatabase;

    private string $dir;

    private City $city;

    protected function setUp(): void
    {
        parent::setUp();

        $this->dir = storage_path('framework/testing/boundaries');
        File::ensureDirectoryExists($this->dir);
        File::cleanDirectory($this->dir);

        $province = Province::create(['code' => '072200000', 'name' => 'Cebu']);
        $this->city = City::create([
            'province_id' => $province->id,
            'code' => '072230000',
            'name' => 'Mandaue City',
        ]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->dir);

        parent::tearDown();
    }

    /** A square polygon around the given point. */
    private function square(float $lng, float $lat, float $size = 0.02): array
    {
        return ['type' => 'Polygon', 'coordinates' => [[
            [$lng, $lat], [$lng + $size, $lat], [$lng + $size, $lat + $size], [$lng, $lat + $size], [$lng, $lat],
        ]]];
    }

    private function writeCityFile(array $features, ?string $cityCode = null): void
    {
        $code = $cityCode ?? $this->city->code;

        File::put(
            "{$this->dir}/barangays-municity-ph{$code}.0.01.json",
            json_encode(['type' => 'FeatureCollection', 'features' => $features]),
        );
    }

    private function feature(string $code, string $name, ?array $geometry = null, ?string $cityCode = null): array
    {
        return [
            'type' => 'Feature',
            'properties' => [
                'ADM3_PCODE' => 'PH' . ($cityCode ?? $this->city->code),
                'ADM4_PCODE' => "PH{$code}",
                'ADM4_EN' => $name,
            ],
            'geometry' => $geometry ?? $this->square(123.94, 10.33),
        ];
    }

    private function import(array $extra = []): int
    {
        return $this->artisan('boundaries:import', array_merge([
            '--scope' => 'barangays',
            '--city' => [$this->city->code],
            '--from' => $this->dir,
        ], $extra))->run();
    }

    #[Test]
    public function it_imports_barangays_with_their_psgc_codes(): void
    {
        $this->writeCityFile([
            $this->feature('072230001', 'Alang-alang'),
            $this->feature('072230002', 'Bakilid'),
        ]);

        $this->import();

        $this->assertSame(2, Barangay::count());
        $alang = Barangay::where('code', '072230001')->first();
        $this->assertSame('Alang-alang', $alang->name);
        $this->assertSame('philippines-json-maps-2019', $alang->boundary_source);
        $this->assertNotNull($alang->boundary_verified_at);
    }

    #[Test]
    public function it_attaches_codes_to_existing_rows_instead_of_duplicating_them(): void
    {
        $existing = Barangay::create(['city_id' => $this->city->id, 'name' => 'Alang-alang']);
        $user = User::factory()->create(['barangay_id' => $existing->id]);

        $this->writeCityFile([$this->feature('072230001', 'Alang-alang')]);

        $this->import();

        $this->assertSame(1, Barangay::count(), 'The existing row must absorb the code, not gain a twin.');
        $this->assertSame('072230001', $existing->fresh()->code);
        $this->assertNotNull($existing->fresh()->boundary);
        $this->assertSame($existing->id, $user->fresh()->barangay_id, 'A registered user must not be orphaned.');
    }

    #[Test]
    public function it_keeps_the_local_spelling_when_upstream_differs(): void
    {
        $existing = Barangay::create(['city_id' => $this->city->id, 'name' => 'Paknaan']);

        $this->writeCityFile([$this->feature('072230020', 'Pakna-an')]);

        $this->import();

        $this->assertSame(1, Barangay::count());
        $this->assertSame('Paknaan', $existing->fresh()->name);
        $this->assertSame('072230020', $existing->fresh()->code);
    }

    #[Test]
    public function it_matches_the_psgc_poblacion_abbreviation(): void
    {
        $existing = Barangay::create(['city_id' => $this->city->id, 'name' => 'Centro (Poblacion)']);

        $this->writeCityFile([$this->feature('072230010', 'Centro (Pob.)')]);

        $this->import();

        $this->assertSame(1, Barangay::count(), '"Centro (Pob.)" and "Centro (Poblacion)" are the same place.');
        $this->assertSame('072230010', $existing->fresh()->code);
    }

    #[Test]
    public function it_skips_invalid_geometry_without_failing_the_run(): void
    {
        $this->writeCityFile([
            $this->feature('072230001', 'Good'),
            $this->feature('072230002', 'Broken', ['type' => 'Point', 'coordinates' => [123.9, 10.3]]),
        ]);

        $this->assertSame(0, $this->import());
        $this->assertSame(1, Barangay::count());
        $this->assertNull(Barangay::where('code', '072230002')->first());
    }

    #[Test]
    public function it_rejects_a_shape_that_belongs_to_another_province(): void
    {
        $this->city->update(['boundary' => $this->square(123.90, 10.30, 0.10)]);

        $this->writeCityFile([
            $this->feature('072230001', 'Local'),
            $this->feature('072230002', 'Davao stray', $this->square(125.60, 7.10)),
        ]);

        $this->import();

        $this->assertNotNull(Barangay::where('code', '072230001')->first());
        $this->assertNull(Barangay::where('code', '072230002')->first());
    }

    #[Test]
    public function it_keeps_an_offshore_barangay_its_city_outline_excludes(): void
    {
        $this->city->update(['boundary' => $this->square(123.90, 10.30, 0.10)]);

        // Just off the coast — outside the drawn outline, unmistakably still
        // the same municipality.
        $this->writeCityFile([$this->feature('072230030', 'Island', $this->square(124.05, 10.42))]);

        $this->import();

        $this->assertNotNull(Barangay::where('code', '072230030')->first(), 'Island barangays must not be dropped.');
    }

    #[Test]
    public function it_accepts_a_barangay_whose_city_has_no_outline_to_check_against(): void
    {
        // Mandaue is one of ~24 cities with no boundary of its own.
        $this->assertNull($this->city->boundary);

        $this->writeCityFile([$this->feature('072230001', 'Alang-alang')]);

        $this->import();

        $this->assertNotNull(Barangay::where('code', '072230001')->first());
    }

    #[Test]
    public function it_rejects_a_file_belonging_to_a_different_city(): void
    {
        $this->writeCityFile([$this->feature('072209001', 'Somewhere else', null, '072209000')]);

        $this->import();

        $this->assertSame(0, Barangay::count());
    }

    #[Test]
    public function it_reports_a_missing_file_without_throwing(): void
    {
        // No exception, no rows — but a run that imported nothing at all exits
        // non-zero, so a wrong --from path or a dead URL can't pass silently.
        $this->assertSame(1, $this->import());
        $this->assertSame(0, Barangay::count());
    }

    #[Test]
    public function re_running_changes_nothing(): void
    {
        $this->writeCityFile([$this->feature('072230001', 'Alang-alang')]);

        $this->import();
        $first = Barangay::where('code', '072230001')->first();

        $this->import();

        $this->assertSame(1, Barangay::count());
        $this->assertEquals($first->boundary_verified_at, Barangay::where('code', '072230001')->first()->boundary_verified_at);
    }

    #[Test]
    public function it_leaves_local_rows_with_no_upstream_match_alone(): void
    {
        $orphan = Barangay::create(['city_id' => $this->city->id, 'name' => 'Made Up Barangay']);
        $user = User::factory()->create(['barangay_id' => $orphan->id]);

        $this->writeCityFile([$this->feature('072230001', 'Alang-alang')]);

        $this->import();

        $this->assertNotNull($orphan->fresh(), 'Unmatched local rows must never be deleted.');
        $this->assertNull($orphan->fresh()->code);
        $this->assertSame($orphan->id, $user->fresh()->barangay_id);
    }

    #[Test]
    public function it_imports_province_outlines(): void
    {
        File::put(
            "{$this->dir}/provinces-region-ph070000000.0.01.json",
            json_encode(['type' => 'FeatureCollection', 'features' => [[
                'type' => 'Feature',
                'properties' => ['ADM2_PCODE' => 'PH072200000', 'ADM2_EN' => 'Cebu'],
                'geometry' => $this->square(123.0, 10.0, 1.0),
            ]]]),
        );

        $this->artisan('boundaries:import', [
            '--scope' => 'provinces',
            '--province' => ['072200000'],
            '--from' => $this->dir,
        ])->assertExitCode(0);

        $province = Province::where('code', '072200000')->first();
        $this->assertNotNull($province->boundary);
        $this->assertSame('philippines-json-maps-2019', $province->boundary_source);
    }

    #[Test]
    public function importing_never_touches_the_network_when_reading_local_files(): void
    {
        Http::preventStrayRequests();

        $this->writeCityFile([$this->feature('072230001', 'Alang-alang')]);

        $this->import();

        $this->assertSame(1, Barangay::count());
    }
}
