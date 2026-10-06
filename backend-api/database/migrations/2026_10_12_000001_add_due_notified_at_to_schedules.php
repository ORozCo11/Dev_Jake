<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('vehicle_maintenance_schedules', function (Blueprint $table) {
            // When the Custodians were told this schedule is due — stops the
            // daily job from notifying about the same schedule every day.
            $table->timestamp('due_notified_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('vehicle_maintenance_schedules', fn (Blueprint $table) => $table->dropColumn('due_notified_at'));
    }
};