<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * VMS-IMPROVEMENT-PLAN.md Phase A3 — a cannibalized repair (parts taken
     * from another vehicle) needs an Admin's sign-off before it counts as
     * done, since it's really two actions in one: fixing this vehicle by
     * un-fixing another. `cannibalization_status` is null for every repair
     * that ISN'T cannibalized (in_house/external skip this gate entirely);
     * 'Pending' while logRepairs() has parked the sub-issue awaiting Admin
     * review instead of sending it straight to Custodian verification;
     * 'Approved'/'Rejected' once reviewed.
     */
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->string('cannibalization_status')->nullable()->after('source_vehicle_id');
            $table->text('cannibalization_rejection_reason')->nullable()->after('cannibalization_status');
            // Plain nullable columns (no DB-level FK) — same convention as
            // deferred_by/deferred_issue_report_id above: SQLite cannot add
            // a foreign-key constraint to an existing table, and the
            // Eloquent relationships work without one.
            $table->unsignedBigInteger('cannibalization_reviewed_by')->nullable()->after('cannibalization_rejection_reason');
            $table->timestamp('cannibalization_reviewed_at')->nullable()->after('cannibalization_reviewed_by');
            // The auto-created "part removed" Issue Report on the DONOR
            // vehicle, once approved — same "keep a pointer to what this
            // action produced" convention as sub-issues' own
            // deferred_issue_report_id.
            $table->unsignedBigInteger('cannibalization_issue_report_id')->nullable()->after('cannibalization_reviewed_at');
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn([
                'cannibalization_status',
                'cannibalization_rejection_reason',
                'cannibalization_reviewed_by',
                'cannibalization_reviewed_at',
                'cannibalization_issue_report_id',
            ]);
        });
    }
};
