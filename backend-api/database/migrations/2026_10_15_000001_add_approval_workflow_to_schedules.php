<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * A Custodian-created schedule now parks at 'Pending Approval' until an
     * Admin reviews it — mirroring the ticket proposal workflow exactly
     * (MaintenanceTicket's 'Pending Approval'/'Declined' + decline_reason).
     *
     * status was an enum('Scheduled','Completed','Cancelled'), whose SQLite
     * CHECK constraint would reject the two new values. Same fix as
     * progress_status_to_string_on_maintenance_records: widen to a plain
     * string: the allowed set is enforced at the application layer
     * (Rule::in in FleetController), which is the single source of truth.
     */
    public function up(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->string('status', 30)->default('Scheduled')->change();
            $table->text('decline_reason')->nullable()->after('status');
        });
    }

    public function down(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->dropColumn('decline_reason');
            $table->enum('status', ['Scheduled', 'Completed', 'Cancelled'])->default('Scheduled')->change();
        });
    }
};
