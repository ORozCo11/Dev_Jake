<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // "Request Custodian Inspection" has no ticket/issue/schedule to point
        // at yet — the notification must open the vehicle itself.
        Schema::table('notifications', function (Blueprint $table) {
            $table->foreignId('vehicle_id')->nullable()->after('schedule_id')
                ->constrained('vehicles', 'vehicle_id')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('notifications', function (Blueprint $table) {
            $table->dropConstrainedForeignId('vehicle_id');
        });
    }
};
