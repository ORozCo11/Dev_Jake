<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Repair Type used to only exist on the standalone Maintenance Record
     * form. Tickets now capture it directly on each sub-issue — either at
     * ticket creation (when the reporter already knows how it'll be fixed)
     * or at the Log Repairs step (once a mechanic actually starts the work).
     * source_vehicle_id mirrors the same column already on
     * vehicle_maintenance_records, naming the DONOR vehicle when a part is
     * cannibalized.
     */
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->string('repair_type')->nullable()->after('maintenance_type'); // in_house, cannibalized, external
            $table->unsignedBigInteger('source_vehicle_id')->nullable()->after('repair_type');
            $table->foreign('source_vehicle_id')->references('vehicle_id')->on('vehicles')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropForeign(['source_vehicle_id']);
            $table->dropColumn(['repair_type', 'source_vehicle_id']);
        });
    }
};
