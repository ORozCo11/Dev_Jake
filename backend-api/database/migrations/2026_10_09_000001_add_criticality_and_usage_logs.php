<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('vehicle_categories', function (Blueprint $table) {
            // Critical | High | Normal — every vehicle of this type starts here.
            $table->string('default_criticality', 10)->default('Normal');
        });
        Schema::table('vehicles', function (Blueprint $table) {
            // Admin override of the type default; null = inherit it.
            $table->string('criticality', 10)->nullable();
        });

        Schema::create('vehicle_usage_logs', function (Blueprint $table) {
            $table->id('usage_id');
            $table->foreignId('vehicle_id')->constrained('vehicles', 'vehicle_id')->cascadeOnDelete();
            $table->foreignId('logged_by')->constrained('users')->cascadeOnDelete();
            $table->string('purpose');
            $table->string('destination')->nullable();
            $table->string('driver_name')->nullable();
            $table->timestamp('started_at');
            $table->timestamp('ended_at')->nullable();
            $table->unsignedInteger('odometer_start')->nullable();
            $table->unsignedInteger('odometer_end')->nullable();
            $table->text('notes')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vehicle_usage_logs');
        Schema::table('vehicles', fn (Blueprint $table) => $table->dropColumn('criticality'));
        Schema::table('vehicle_categories', fn (Blueprint $table) => $table->dropColumn('default_criticality'));
    }
};