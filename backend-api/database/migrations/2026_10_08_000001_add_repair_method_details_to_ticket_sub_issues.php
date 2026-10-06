<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            // Cannibalized: which part, how many, its condition, why this donor, when fitted.
            $table->unsignedInteger('part_quantity')->nullable();
            $table->string('part_condition')->nullable();
            $table->text('cannibal_reason')->nullable();
            $table->date('part_installed_at')->nullable();
            // External: sent out -> returned stages.
            $table->timestamp('external_sent_at')->nullable();
            $table->timestamp('external_returned_at')->nullable();
            $table->text('external_return_notes')->nullable();
            $table->decimal('external_actual_cost', 12, 2)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('ticket_sub_issues', function (Blueprint $table) {
            $table->dropColumn(['part_quantity', 'part_condition', 'cannibal_reason', 'part_installed_at', 'external_sent_at', 'external_returned_at', 'external_return_notes', 'external_actual_cost']);
        });
    }
};
