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
        // Production-readiness audit finding #6 — vehicle.create was a flat
        // role grant (every Custodian could register), even though the
        // capability docs describe it as "when delegated/authorized." This
        // is the actual per-account delegation toggle: Admin can always
        // register; a Custodian can only if this is true. Irrelevant for
        // any other role (Maintenance Personnel is never eligible).
        Schema::table('users', function (Blueprint $table) {
            $table->boolean('can_register_vehicles')->default(false)->after('roles');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('can_register_vehicles');
        });
    }
};
