<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A Custodian proposing a ticket (TicketController::proposeTicket) can name
 * who they think should do the repair, without that actually becoming the
 * real assignment yet — assigned_mechanic_id only gets set for real once an
 * Admin approves the proposal (TicketController::approveTicket), same
 * dispatch step assignMechanic() already performs elsewhere. Kept as its
 * own nullable column rather than reusing assigned_mechanic_id so a
 * pending proposal never LOOKS dispatched (e.g. to anything reading
 * assigned_mechanic_id to mean "this mechanic has real work assigned")
 * before an Admin has actually said so.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->foreignId('suggested_mechanic_id')->nullable()->after('assigned_mechanic_id')->constrained('users')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropForeign(['suggested_mechanic_id']);
            $table->dropColumn('suggested_mechanic_id');
        });
    }
};
