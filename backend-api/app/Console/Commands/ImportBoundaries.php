<?php

namespace App\Console\Commands;

use App\Models\Barangay;
use App\Models\City;
use App\Models\Province;
use App\Rules\ValidGeoBoundary;
use App\Support\PhilippinesJsonMaps;
use Illuminate\Console\Command;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * Loads Philippine administrative outlines into the local database, so the
 * app already knows every boundary before anyone registers — no drawing, no
 * uploads, and no file reads on the registration path.
 *
 * Run once during setup (nationwide takes a few minutes); re-running is
 * harmless and changes nothing unless --force is passed.
 */
class ImportBoundaries extends Command
{
    protected $signature = 'boundaries:import
        {--scope=all : all|provinces|barangays}
        {--province=* : Limit to these PSGC province codes}
        {--city=* : Limit to these PSGC city codes}
        {--resolution=medres : hires|medres|lowres}
        {--from= : Read GeoJSON from this local directory instead of the network}
        {--force : Overwrite outlines that were already imported}
        {--dry-run : Report what would change without writing}
        {--timeout=20 : HTTP timeout in seconds}
        {--retries=3 : HTTP attempts per file}';

    protected $description = 'Import Philippine province/barangay boundaries from philippines-json-maps';

    /** Every outcome worth reporting; nothing here aborts the run. */
    private array $tally = [
        'provinces_written' => 0,
        'barangays_written' => 0,
        'codes_attached' => 0,
        'skipped_existing' => 0,
        'missing_file' => 0,
        'fetch_failed' => 0,
        'city_code_mismatch' => 0,
        'invalid_geometry' => 0,
        'outside_parent' => 0,
        'outside_parent_kept' => 0,
        'unverified_parent' => 0,
    ];

    private array $nameDivergences = [];

    private ?string $firstFetchError = null;

    public function handle(): int
    {
        $scope = $this->option('scope');

        if (! in_array($scope, ['all', 'provinces', 'barangays'], true)) {
            $this->error("Invalid --scope={$scope}. Use all, provinces or barangays.");

            return self::FAILURE;
        }

        if ($this->option('dry-run')) {
            $this->warn('Dry run — nothing will be written.');
        }

        if ($scope !== 'barangays') {
            $this->importProvinces();
        }

        if ($scope !== 'provinces') {
            $this->importBarangays();
        }

        $this->report();

        $wrote = $this->tally['provinces_written'] + $this->tally['barangays_written'] + $this->tally['codes_attached'];

        // A re-run legitimately writes nothing, and so does a dry run.
        $nothingExpected = $this->option('dry-run') || $this->tally['skipped_existing'] > 0;

        return ($wrote === 0 && ! $nothingExpected) ? self::FAILURE : self::SUCCESS;
    }

    private function importProvinces(): void
    {
        $provinces = Province::whereNotNull('code')
            ->when($this->option('province'), fn ($q, $codes) => $q->whereIn('code', $codes))
            ->get();

        if ($provinces->isEmpty()) {
            return;
        }

        $byRegion = $provinces->groupBy(fn ($p) => PhilippinesJsonMaps::regionCodeFor($p->code));
        $this->info("Importing province outlines ({$byRegion->count()} region files)...");

        foreach ($byRegion as $regionCode => $group) {
            $geojson = $this->readGeoJson(PhilippinesJsonMaps::provinceFile($regionCode, $this->option('resolution')));

            if (! $geojson) {
                continue;
            }

            foreach ($geojson['features'] ?? [] as $feature) {
                $code = PhilippinesJsonMaps::stripPcodePrefix($feature['properties']['ADM2_PCODE'] ?? null);
                $province = $code ? $group->firstWhere('code', $code) : null;

                if (! $province) {
                    continue;
                }

                if ($province->boundary && ! $this->option('force')) {
                    $this->tally['skipped_existing']++;
                    continue;
                }

                $geometry = $feature['geometry'] ?? null;

                if (! ValidGeoBoundary::isValid($geometry)) {
                    $this->tally['invalid_geometry']++;
                    continue;
                }

                if (! $this->option('dry-run')) {
                    $province->update($this->boundaryAttributes($geometry));
                }

                $this->tally['provinces_written']++;
            }
        }
    }

    private function importBarangays(): void
    {
        $query = City::whereNotNull('code')
            ->when($this->option('city'), fn ($q, $codes) => $q->whereIn('code', $codes))
            ->when($this->option('province'), function ($q, $codes) {
                $q->whereIn('province_id', Province::whereIn('code', $codes)->pluck('id'));
            });

        $total = $query->count();

        if ($total === 0) {
            $this->warn('No cities matched the given filters.');

            return;
        }

        $this->info("Importing barangay outlines for {$total} cities...");
        $bar = $this->output->createProgressBar($total);
        $bar->start();

        $query->orderBy('code')->chunkById(100, function ($cities) use ($bar) {
            foreach ($cities as $city) {
                $this->importCity($city);
                $bar->advance();
            }
        });

        $bar->finish();
        $this->newLine(2);
    }

    private function importCity(City $city): void
    {
        $geojson = $this->readGeoJson(PhilippinesJsonMaps::barangayFile($city->code, $this->option('resolution')));

        if (! $geojson) {
            return;
        }

        $features = $geojson['features'] ?? [];

        // Guard against a file that isn't actually this city's, which would
        // otherwise plant another municipality's barangays under it.
        $fileCity = PhilippinesJsonMaps::stripPcodePrefix($features[0]['properties']['ADM3_PCODE'] ?? null);

        if ($fileCity && $fileCity !== $city->code) {
            $this->tally['city_code_mismatch']++;

            return;
        }

        $existing = Barangay::where('city_id', $city->id)->get();
        $byCode = $existing->whereNotNull('code')->keyBy('code');
        $byName = $existing->keyBy(fn ($b) => Barangay::normalizeName($b->name));

        $writes = function () use ($features, $city, $byCode, $byName) {
            foreach ($features as $feature) {
                $this->importFeature($feature, $city, $byCode, $byName);
            }
        };

        // One transaction per city keeps memory bounded, avoids a long lock,
        // and leaves a interrupted nationwide run resumable city-by-city.
        $this->option('dry-run') ? $writes() : DB::transaction($writes);
    }

    private function importFeature(array $feature, City $city, $byCode, $byName): void
    {
        $code = PhilippinesJsonMaps::stripPcodePrefix($feature['properties']['ADM4_PCODE'] ?? null);
        $upstreamName = $feature['properties']['ADM4_EN'] ?? null;

        if (! $code || ! $upstreamName) {
            return;
        }

        $geometry = $feature['geometry'] ?? null;

        if (! ValidGeoBoundary::isValid($geometry)) {
            $this->tally['invalid_geometry']++;

            return;
        }

        if ($city->boundary) {
            if (! ValidGeoBoundary::isApproximatelyWithin($geometry, $city->boundary)) {
                // Not inside the city outline. Before dropping a real place,
                // check whether it's merely offshore — island barangays sit
                // outside their municipality's mainland shape routinely.
                if (! ValidGeoBoundary::isNearby($geometry, $city->boundary)) {
                    $this->tally['outside_parent']++;

                    return;
                }

                $this->tally['outside_parent_kept']++;
            }
        } else {
            // ~24 independent cities (Mandaue included) have no outline of
            // their own, so there is nothing to check against. Accept, but
            // say so.
            $this->tally['unverified_parent']++;
        }

        $match = $byCode->get($code) ?? $byName->get(Barangay::normalizeName($upstreamName));

        if (! $match) {
            $this->insertBarangay($city, $code, $upstreamName, $geometry);

            return;
        }

        if ($match->boundary && $match->code && ! $this->option('force')) {
            $this->tally['skipped_existing']++;

            return;
        }

        if ($match->name !== $upstreamName) {
            $this->nameDivergences[] = "{$city->name}: kept \"{$match->name}\" (upstream \"{$upstreamName}\")";
        }

        $hadCode = (bool) $match->code;

        if (! $this->option('dry-run')) {
            // The local name always wins — users registered against it, and
            // the alias map exists precisely to prefer our spelling.
            $match->update($this->boundaryAttributes($geometry) + ['code' => $match->code ?? $code]);
        }

        $hadCode ? $this->tally['barangays_written']++ : $this->tally['codes_attached']++;
    }

    private function insertBarangay(City $city, string $code, string $name, array $geometry): void
    {
        if ($this->option('dry-run')) {
            $this->tally['barangays_written']++;

            return;
        }

        try {
            Barangay::create($this->boundaryAttributes($geometry) + [
                'city_id' => $city->id,
                'code' => $code,
                'name' => $name,
            ]);

            $this->tally['barangays_written']++;
        } catch (QueryException $e) {
            // Raced, or a name collision the normalized lookup didn't catch —
            // attach to whatever is already there rather than failing the city.
            $existing = Barangay::where('city_id', $city->id)
                ->whereRaw('LOWER(name) = ?', [strtolower($name)])
                ->first();

            if (! $existing) {
                throw $e;
            }

            $existing->update($this->boundaryAttributes($geometry) + ['code' => $existing->code ?? $code]);
            $this->tally['codes_attached']++;
        }
    }

    private function boundaryAttributes(array $geometry): array
    {
        return [
            'boundary' => $geometry,
            'boundary_source' => PhilippinesJsonMaps::SOURCE_LABEL,
            'boundary_verified_at' => now(),
        ];
    }

    /** Returns the decoded FeatureCollection, or null (tallied) on any failure. */
    private function readGeoJson(string $file): ?array
    {
        if ($dir = $this->option('from')) {
            $path = rtrim($dir, '/\\') . '/' . basename($file);

            if (! is_file($path)) {
                $this->tally['missing_file']++;

                return null;
            }

            return json_decode(file_get_contents($path), true);
        }

        try {
            $response = Http::timeout((int) $this->option('timeout'))
                ->retry((int) $this->option('retries'), 200, throw: false)
                ->get(PhilippinesJsonMaps::url($file));
        } catch (\Throwable $e) {
            // DNS/connection failure survives the retries — one unreachable
            // file must not end a nationwide run.
            $this->tally['fetch_failed']++;
            $this->firstFetchError ??= $e->getMessage();

            return null;
        }

        if ($response->status() === 404) {
            $this->tally['missing_file']++;

            return null;
        }

        if (! $response->successful()) {
            $this->tally['fetch_failed']++;

            return null;
        }

        return $response->json();
    }

    private function report(): void
    {
        $rows = [];

        foreach ($this->tally as $key => $count) {
            if ($count > 0) {
                $rows[] = [str_replace('_', ' ', $key), $count];
            }
        }

        $this->table(['Outcome', 'Count'], $rows ?: [['nothing to do', 0]]);

        if ($this->firstFetchError) {
            $this->newLine();
            $this->error('Downloads failed. First error:');
            $this->line('  ' . $this->firstFetchError);

            if (str_contains(strtolower($this->firstFetchError), 'certificate')) {
                $this->newLine();
                $this->warn("PHP has no CA bundle configured, so it can't verify HTTPS certificates.");
                $this->line('  Fix it once: download https://curl.se/ca/cacert.pem, then set both');
                $this->line('  curl.cainfo and openssl.cafile to its full path in your php.ini,');
                $this->line('  and restart any running PHP process.');
                $this->line('  Or work offline: download the files with curl and pass --from=<dir>.');
            }
        }

        if ($this->nameDivergences) {
            $this->newLine();
            $this->warn('Kept local spellings that differ from upstream:');

            foreach (array_slice($this->nameDivergences, 0, 20) as $line) {
                $this->line("  {$line}");
            }

            if (count($this->nameDivergences) > 20) {
                $this->line('  ... ' . (count($this->nameDivergences) - 20) . ' more');
            }
        }
    }
}
