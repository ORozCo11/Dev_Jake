<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Final stabilization — a barangay's `boundary` was a bare "set or not"
     * boolean (`has_boundary`). This gives it a real status a Super Admin can
     * trust: VERIFIED (explicitly confirmed), NOT FOUND (the public geocoder
     * never produced a usable match), or null (never attempted). A found-but-
     * not-yet-reviewed match lands in `pending_boundary` instead of
     * `boundary` directly — "NEEDS REVIEW" is derived from its presence, not
     * its own stored state, so there's exactly one place a boundary is ever
     * "live" (boundary) and one place it's "proposed" (pending_boundary).
     */
    public function up(): void
    {
        Schema::table('barangays', function (Blueprint $table) {
            $table->string('boundary_status')->nullable()->after('boundary');
            $table->string('boundary_source')->nullable()->after('boundary_status');
            $table->timestamp('boundary_verified_at')->nullable()->after('boundary_source');
            $table->foreignId('boundary_verified_by')->nullable()->after('boundary_verified_at')
                ->constrained('users')->nullOnDelete();
            $table->json('pending_boundary')->nullable()->after('boundary_verified_by');
            $table->string('pending_boundary_source')->nullable()->after('pending_boundary');
        });

        // Backfill — a barangay that already has a boundary on file (the 27
        // seeded Mandaue barangays, the Mantalongon PSA file) got there
        // before this status existed; it's real, already-good data, not
        // something that should suddenly read as unreviewed.
        DB::table('barangays')->whereNotNull('boundary')->update([
            'boundary_status' => 'verified',
            'boundary_source' => 'legacy',
            'boundary_verified_at' => now(),
        ]);
    }

    public function down(): void
    {
        Schema::table('barangays', function (Blueprint $table) {
            $table->dropConstrainedForeignId('boundary_verified_by');
            $table->dropColumn(['boundary_status', 'boundary_source', 'boundary_verified_at', 'pending_boundary', 'pending_boundary_source']);
        });
    }
};
