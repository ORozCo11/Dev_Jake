<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('cities', function (Blueprint $table) {
            $table->string('boundary_source')->nullable()->after('boundary');
            $table->timestamp('boundary_verified_at')->nullable()->after('boundary_source');
        });

        Schema::table('barangays', function (Blueprint $table) {
            $table->string('boundary_source')->nullable()->after('boundary');
            $table->timestamp('boundary_verified_at')->nullable()->after('boundary_source');
        });

        // Backfill rows that were already seeded before these tracking columns
        // existed (a fresh install instead gets these set directly by the
        // seeders/migration that write `boundary` in the first place).
        DB::table('cities')->whereNotNull('boundary')->update([
            'boundary_source' => 'philippines-json-maps',
            'boundary_verified_at' => now(),
        ]);
        DB::table('barangays')->whereNotNull('boundary')->update([
            'boundary_source' => 'philippines-json-maps',
            'boundary_verified_at' => now(),
        ]);

        // Mantalongon's polygon was hand-transcribed directly into
        // 2026_09_01_000001_seed_mantalongon_boundary.php rather than bulk-
        // seeded from the vendored mandaue-barangay-boundaries.json file —
        // distinct source label per GEOJSON_BOUNDARY_RULES.md's example.
        DB::table('barangays')->where('name', 'Mantalongon')->whereNotNull('boundary')
            ->update(['boundary_source' => 'philippines-json-maps-manual']);
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('cities', function (Blueprint $table) {
            $table->dropColumn(['boundary_source', 'boundary_verified_at']);
        });

        Schema::table('barangays', function (Blueprint $table) {
            $table->dropColumn(['boundary_source', 'boundary_verified_at']);
        });
    }
};
