<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        // Production-readiness audit finding #10 — only ticket_id existed, so
        // clicking an issue-report or schedule notification couldn't open the
        // specific record it was about; it just marked itself read and the
        // user was left wherever they already were.
        Schema::table('notifications', function (Blueprint $table) {
            $table->foreignId('issue_report_id')->nullable()->after('ticket_id')
                ->constrained('vehicle_issue_reports', 'issue_report_id')->nullOnDelete();
            $table->foreignId('schedule_id')->nullable()->after('issue_report_id')
                ->constrained('vehicle_maintenance_schedules', 'schedule_id')->nullOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('notifications', function (Blueprint $table) {
            $table->dropConstrainedForeignId('issue_report_id');
            $table->dropConstrainedForeignId('schedule_id');
        });
    }
};
