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
        Schema::create('issue_report_attachments', function (Blueprint $table) {
            $table->id('attachment_id');
            $table->foreignId('issue_report_id')->constrained('vehicle_issue_reports', 'issue_report_id')->onDelete('cascade');
            $table->string('file_url');
            $table->string('original_name')->nullable();
            $table->foreignId('uploaded_by')->constrained('users');
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('issue_report_attachments');
    }
};
