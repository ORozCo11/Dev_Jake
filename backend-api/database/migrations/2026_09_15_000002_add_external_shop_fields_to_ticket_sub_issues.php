<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * These two already exist on vehicle_maintenance_records for the
     * "external" repair type (which vendor/shop did the work, and how long
     * the repair is warrantied) — carrying them onto sub-issues too now that
     * a ticket can be born (or logged) as an external-shop repair directly.
     */
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->string('external_vendor')->nullable()->after('source_vehicle_id');
            $table->date('warranty_until')->nullable()->after('external_vendor');
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn(['external_vendor', 'warranty_until']);
        });
    }
};
