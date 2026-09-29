<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Links a Maintenance Schedule to the ticket auto-created for it on its due
 * date (see App\Console\Commands\ConvertDueSchedulesToTickets), same
 * pattern as vehicle_maintenance_schedules.resulting_maintenance_id and
 * vehicle_condition_checks.resulting_ticket_id. Set once, the day the
 * schedule comes due, and never changed again — it's what stops the daily
 * command from converting the same schedule into a second ticket, and lets
 * the UI show "Ticket #X was created for this" once it happens.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->unsignedBigInteger('resulting_ticket_id')->nullable()->after('resulting_maintenance_id');
            $table->foreign('resulting_ticket_id')->references('ticket_id')->on('maintenance_tickets')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->dropForeign(['resulting_ticket_id']);
            $table->dropColumn('resulting_ticket_id');
        });
    }
};
