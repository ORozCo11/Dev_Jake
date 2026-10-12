<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vehicle_type_fields', function (Blueprint $table) {
            $table->id('field_id');
            $table->foreignId('category_id')->constrained('vehicle_categories', 'category_id')->cascadeOnDelete();
            // `key` is the stable identity values are stored under; it is
            // generated once from the label and never changes on rename.
            $table->string('key', 60);
            $table->string('label');
            $table->string('field_type', 20); // text | number | dropdown | date | yes_no
            $table->boolean('is_required')->default(false);
            $table->string('unit', 30)->nullable();
            $table->json('options')->nullable();
            $table->unsignedInteger('sort_order')->default(0);
            // Archive, don't delete: vehicles keep the values they already hold.
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->unique(['category_id', 'key']);
        });

        Schema::table('vehicles', function (Blueprint $table) {
            $table->json('custom_values')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('vehicles', fn (Blueprint $table) => $table->dropColumn('custom_values'));
        Schema::dropIfExists('vehicle_type_fields');
    }
};
