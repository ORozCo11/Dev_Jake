<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * New work uses one accountable mechanic per ticket. Existing per-line
     * assignments deliberately remain as historical repair evidence.
     *
     * `due_notified_at` makes a due schedule a single reminder/prefill event
     * instead of creating a live ticket or notifying people every day.
     */
    public function up(): void
    {
        Schema::table('maintenance_tickets', function (Blueprint $table) {
            $table->foreignId('assigned_mechanic_id')
                ->nullable()
                ->after('assigned_custodian_id')
                ->constrained('users')
                ->nullOnDelete();
        });

        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->timestamp('due_notified_at')->nullable()->after('resulting_ticket_id');
        });
    }

    public function down(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            $table->dropColumn('due_notified_at');
        });

        Schema::table('maintenance_tickets', function (Blueprint $table) {
            $table->dropConstrainedForeignId('assigned_mechanic_id');
        });
    }
};
