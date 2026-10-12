<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Final senior system review — self-verification gap. Both verifyRepair()
     * and confirmSubIssue() only ever checked the CURRENT assigned_mechanic_id
     * against the caller. A mechanic who does real repair work, then gets
     * reassigned away mid-repair (reassignMechanic() only fires while still
     * 'Under Repair', before logRepairs() finalizes it) was never blocked
     * from later verifying/confirming their own earlier work if they also
     * happened to hold this ticket's Custodian hat — because by then
     * assigned_mechanic_id names the new mechanic, not them.
     *
     * prior_mechanic_ids — every mechanic who was ever assigned_mechanic_id
     * on this sub-issue before the current one, appended to by
     * reassignMechanic(). Checked alongside assigned_mechanic_id by both
     * self-verification guards.
     */
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->json('prior_mechanic_ids')->nullable()->after('assigned_mechanic_id');
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn('prior_mechanic_ids');
        });
    }
};
