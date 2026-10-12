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
        // "Reported On Behalf Of" catalog — a growing list of driver/person
        // names, same shape as fault_categories/maintenance_types, so it can
        // be a CreatableSelect dropdown instead of a plain free-text field.
        Schema::create('reported_persons', function (Blueprint $table) {
            $table->id();
            $table->string('name')->unique();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('reported_persons');
    }
};
