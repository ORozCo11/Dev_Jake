<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            // Cannibalized: what's broken/missing on the vehicle being fixed,
            // and which part gets pulled off the donor to fix it.
            $table->string('part_missing')->nullable()->after('source_vehicle_id');
            $table->string('part_needed')->nullable()->after('part_missing');
            // External: the objective basis for sending it out, what the shop
            // is actually asked to do, and how to reach them.
            $table->string('external_reason')->nullable()->after('external_vendor');
            $table->text('external_work_scope')->nullable()->after('external_reason');
            $table->string('external_shop_contact')->nullable()->after('external_work_scope');
            $table->decimal('external_estimated_cost', 12, 2)->nullable()->after('external_shop_contact');
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn(['part_missing', 'part_needed', 'external_reason', 'external_work_scope', 'external_shop_contact', 'external_estimated_cost']);
        });
    }
};
