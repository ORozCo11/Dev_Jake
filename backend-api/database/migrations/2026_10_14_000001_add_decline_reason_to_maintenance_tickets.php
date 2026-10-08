<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Declining a proposal used to delete the ticket row outright. Now it
     * becomes a visible, reversible status instead (both sides can see it
     * was declined, and Admin can undecline or approve it directly) — this
     * is where the reason is kept once there's a persistent row to keep it on.
     */
    public function up(): void
    {
        Schema::table('maintenance_tickets', function (Blueprint $table) {
            $table->text('decline_reason')->nullable()->after('status');
        });
    }

    public function down(): void
    {
        Schema::table('maintenance_tickets', function (Blueprint $table) {
            $table->dropColumn('decline_reason');
        });
    }
};
