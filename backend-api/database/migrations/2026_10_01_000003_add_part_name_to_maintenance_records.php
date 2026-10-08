<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('vehicle_maintenance_records', function (Blueprint $table) {
            // Which specific part was taken off the source vehicle — Source
            // Vehicle alone names the donor, not what was actually removed.
            $table->string('part_name')->nullable()->after('source_vehicle_id');
        });
    }

    public function down(): void
    {
        Schema::table('vehicle_maintenance_records', function (Blueprint $table) {
            $table->dropColumn('part_name');
        });
    }
};
