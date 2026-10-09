# Software Requirements Specification

## Barangay Vehicle Management System

**Document ID:** VMS-SRS-001  
**Version:** 1.0  
**Date:** October 8, 2026  
**Document status:** Baseline SRS for capstone presentation, validation, and system testing  
**System type:** Web-based, multi-barangay emergency fleet management system

---

## Document Control

| Item | Description |
|---|---|
| Project | Barangay Vehicle Management System (VMS) |
| Primary purpose | Manage the availability, condition, readiness, maintenance, location, and history of barangay emergency vehicles |
| Intended users | Super Admin, Barangay Admin, Custodian, and Maintenance Personnel |
| Frontend | React single-page application |
| Backend | Laravel REST API |
| Authentication | Laravel Sanctum bearer-token authentication |
| Data storage | Relational database; SQLite for local development and PostgreSQL-ready deployment |
| File storage | S3-compatible object storage for supported photos and attachments |
| Prepared for | Capstone documentation and panel defense |

### Revision History

| Version | Date | Description |
|---|---|---|
| 1.0 | October 8, 2026 | Initial full SRS aligned with the implemented repository and project documentation |

---

# 1. Introduction

## 1.1 Purpose

This Software Requirements Specification defines the functional and non-functional requirements of the Barangay Vehicle Management System. It establishes the system scope, user roles, workflows, data requirements, business rules, interfaces, constraints, and acceptance criteria.

The SRS is intended to serve as a shared reference for:

- the project proponents and developers;
- capstone advisers and panel members;
- barangay and disaster-response stakeholders;
- software testers and user-acceptance testers; and
- future maintainers of the application.

## 1.2 Product Vision

The Barangay VMS shall provide authorized personnel with a centralized and traceable way to determine:

1. what emergency vehicles belong to the barangay;
2. where each unit is stationed;
3. whether each vehicle is available or unavailable;
4. what physical condition has been recorded;
5. whether a recent readiness check supports deployment;
6. what issues, repairs, and preventive-maintenance tasks exist;
7. who is responsible for each maintenance activity; and
8. whether the vehicle has passed the controls required for return to service.

The system supports emergency preparedness through vehicle management. It does not perform the emergency response itself.

## 1.3 Problem Statement

Emergency vehicles may be recorded in an inventory without current evidence that they are operationally ready. When condition reports, maintenance schedules, repair records, vehicle locations, and staff responsibilities are managed separately, decision-makers may have difficulty identifying which units are genuinely available and serviceable.

The system addresses this problem by consolidating emergency-fleet records and enforcing a structured lifecycle from defect reporting through inspection, repair, verification, confirmation, and controlled return to service.

## 1.4 Objectives

The system shall:

- centralize barangay emergency-vehicle information;
- distinguish vehicle availability from physical condition and verified readiness;
- support documented readiness and condition checks;
- schedule and record preventive maintenance;
- provide a traceable corrective-maintenance workflow;
- prevent premature return of unsafe or unresolved vehicles to service;
- show the station or hub assigned to each vehicle;
- preserve vehicle, maintenance, and user-action histories;
- provide role-based access and barangay-level data separation; and
- produce management information for fleet-readiness decisions.

## 1.5 Scope

### 1.5.1 In Scope

- User authentication and account management
- Multi-role user accounts
- Multi-barangay data separation
- Vehicle and vehicle-type management
- Support for land and water vehicle categories
- Vehicle photos and supporting documents
- Availability and condition monitoring
- Readiness checklists and freshness status
- Vehicle issue reporting
- Main-issue and sub-issue maintenance tickets
- Mechanic and custodian assignment or reassignment
- Repair, parts, cost, verification, and confirmation records
- Deferred-work safeguards and fit-for-service decisions
- Preventive-maintenance scheduling and recurring schedules
- Direct or external maintenance records
- Vehicle hubs and station-based location mapping
- Vehicle histories, activity logs, notifications, archives, and reports
- Reliability, downtime, recurring-failure, readiness, and coverage indicators
- Vehicle archiving, restoration, decommissioning, and recommissioning where permitted
- Super Admin oversight of barangay accounts and public concern reports

### 1.5.2 Out of Scope

- Live emergency-call intake or computer-aided dispatch
- Assignment of drivers and crews to emergency incidents
- Route optimization and turn-by-turn navigation
- Continuous GPS or telematics tracking
- Patient records, clinical documentation, or hospital coordination
- Incident case management
- Fuel-consumption accounting
- Automated odometer or engine-hour capture
- Odometer-based maintenance triggers
- Automatic registration, insurance, permit, or license-expiry compliance
- Payroll, procurement, inventory of spare parts, and vendor payment processing
- Vehicle sensor diagnostics

These exclusions are deliberate. The current system is focused on fleet availability, readiness, maintenance, and accountability.

## 1.6 Definitions and Acronyms

| Term | Definition |
|---|---|
| VMS | Vehicle Management System |
| LGU | Local Government Unit |
| DRRM | Disaster Risk Reduction and Management |
| BDRRMC | Barangay Disaster Risk Reduction and Management Committee |
| Admin | Authorized barangay fleet administrator |
| Custodian | User responsible for field inspection, issue reporting, readiness checks, and repair verification |
| Maintenance Personnel | User who performs and records vehicle maintenance or repair work |
| Super Admin | Platform-level account administrator without routine access to barangay fleet operations |
| Availability | Administrative state indicating whether a vehicle may be used |
| Condition | Recorded physical state of a vehicle |
| Readiness | Current checklist-based evidence that required operational items passed inspection |
| Main Issue | The maintenance ticket representing the principal reported vehicle problem |
| Sub-Issue | A specific repairable finding under a Main Issue |
| Fit for Service | An explicit decision that a vehicle may safely return to operational availability |
| Hub | A named station, garage, or operational location where vehicles are assigned |
| PM | Preventive maintenance |
| SPA | Single-page application |
| API | Application programming interface |
| RBAC | Role-based access control |
| UAT | User acceptance testing |

## 1.7 Reference Documents

- Project `README.md`
- `docs/VMS_System_Capabilities.pdf`
- `docs/VMS_Strategic_Design.pdf`
- `docs/VMS_Scenario_Dataflows.pdf`
- `docs/VMS_Testing_Guide.pdf`
- `docs/VMS_Defense_QA.pdf`
- `docs/VMS_Comprehensive_QA.pdf`
- Backend API routes, controllers, models, migrations, middleware, and feature tests
- Frontend React application and role-based workspace

---

# 2. Overall Description

## 2.1 Product Perspective

The VMS is a browser-based information system composed of:

```text
Authorized User
      ↓ HTTPS
React Single-Page Application
      ↓ JSON REST API
Laravel Application Server
      ↓
Relational Database + S3-Compatible File Storage
```

The frontend presents role-appropriate modules. The backend validates requests, applies authentication and authorization rules, enforces barangay ownership boundaries, executes workflow rules, and stores auditable records.

## 2.2 Major Product Functions

1. Identity, registration, authentication, and profile management
2. Barangay and account administration
3. Dashboard and fleet-readiness overview
4. Vehicle inventory and lifecycle management
5. Vehicle-type and catalog management
6. Vehicle condition and readiness checking
7. Vehicle issue reporting
8. Maintenance ticket and work-order processing
9. Preventive-maintenance scheduling
10. Direct or historical maintenance recording
11. Hub and vehicle-location management
12. Vehicle reliability and fleet-intelligence reporting
13. Notifications, histories, archives, and audit logs
14. Public concern submission and Super Admin resolution

## 2.3 User Classes

### 2.3.1 Super Admin

The Super Admin manages platform-level account concerns across barangays. This role may view barangay and user account information, activate or deactivate users, update roles, manage barangay registration codes, review platform activity, and resolve public concern reports.

The Super Admin shall not use platform authority to perform ordinary fleet operations on behalf of a barangay unless explicitly designed and authorized in a future version.

### 2.3.2 Barangay Admin

The Admin owns the barangay fleet-management process. The Admin registers vehicles, manages users and reference data, creates tickets, assigns work, confirms repairs, controls ticket closure, reviews reports, and manages vehicle archive or decommission decisions.

### 2.3.3 Custodian

The Custodian reports issues, performs assigned vehicle inspections, records condition and readiness checks, and independently verifies completed repair work using a functional checklist.

### 2.3.4 Maintenance Personnel

Maintenance Personnel receive assigned sub-issues, record repair work, parts, dates, and costs, and submit completed work for verification. They may also participate in preventive-maintenance schedules and maintenance records.

### 2.3.5 Multi-Role User

A barangay user may hold a primary role and one or more additional roles. The interface shall expose the union of modules allowed by those roles. Every recorded action shall remain attributable to the authenticated user and applicable role.

### 2.3.6 Public User

A public user may access the registration-related location lookup and submit a concern without authenticating. Public endpoints shall be rate-limited and shall not expose protected fleet data.

## 2.4 Operating Environment

- Modern desktop or mobile web browser with JavaScript enabled
- Network connection between client and API server
- PHP 8.3 or compatible supported runtime
- Laravel 13.x application framework
- React 19.x frontend
- Relational database supported by the deployment configuration
- S3-compatible storage when uploads are enabled
- HTTPS for deployed environments

## 2.5 Design and Implementation Constraints

- The frontend and backend are decoupled and communicate through JSON APIs.
- Protected API routes require a valid Sanctum bearer token.
- Fleet records are scoped to the authenticated user’s barangay.
- Role checks are enforced server-side and must not rely only on hidden interface controls.
- Map functions depend on Leaflet and configured map tiles.
- File-upload capability depends on correctly configured object storage.
- Geographic boundaries depend on available and valid boundary data.
- The application’s data accuracy depends on timely and truthful user input.
- The readiness checklist does not replace professional mechanical inspection.

## 2.6 Assumptions and Dependencies

- Each participating barangay has at least one approved Admin.
- Authorized users have sufficient training to perform their assigned duties.
- Vehicle types, hubs, and users are configured before dependent transactions are created.
- The barangay defines and approves its operational readiness checklist.
- Users update vehicle condition, location, and maintenance status when events occur.
- Internet and hosting services are sufficiently available for normal use.
- Map tiles and storage services remain accessible under their respective service terms.
- The organization maintains administrative procedures that complement the software controls.

## 2.7 Legal and Operational Context

The system is intended to support local DRRM resource management and emergency-fleet preparedness. It shall not be represented as independently certifying compliance with Republic Act No. 10121 or any other legal, medical, transport, or safety requirement. Compliance remains dependent on the LGU’s complete policies, personnel, training, equipment, records, and operations.

---

# 3. External Interface Requirements

## 3.1 User Interface Requirements

### UI-01 Responsive Interface

The system shall provide a usable interface on common desktop and mobile screen sizes.

### UI-02 Role-Aware Navigation

The system shall display modules and actions appropriate to the authenticated user’s role membership.

### UI-03 Dashboard

                          The dashboard shall summarize fleet status, readiness, maintenance, issues, and attention items without requiring users to inspect every individual record.

                          ### UI-04 Forms and Validation

                          Forms shall:

                          - identify required fields;
- display actionable validation messages;
- preserve valid user input when validation fails where p1ractical;
- require confirmation for consequential actions; and
- prevent duplicate submission where technically practical.

### UI-05 Status Presentation

Statuses shall use consistent labels and visual indicators. Color shall not be the sole means of conveying meaning.

### UI-06 Tables and Search

Record-heavy modules shall provide search, filtering, sorting where applicable, and pagination.

### UI-07 Accessibility

Interactive controls shall have visible labels or accessible names, keyboard-operable behavior where feasible, adequate focus indication, and sufficient contrast.

### UI-08 Theme

The interface shall support consistent light and dark presentation where implemented.

### UI-09 Print and Export

Supported reports shall provide printable output. Supported vehicle and schedule datasets shall provide CSV export.

## 3.2 Software Interfaces

### 3.2.1 REST API

- Requests and responses shall use JSON except for supported multipart file uploads.
- Protected requests shall include a valid bearer token.
- Validation failures shall return structured error information.
- Unauthorized and forbidden requests shall return appropriate HTTP status codes.

### 3.2.2 Database

The backend shall use a relational database and enforce applicable primary keys, foreign keys, unique constraints, and indexes.

### 3.2.3 Object Storage

The system may store vehicle photos, issue attachments, and vehicle documents in S3-compatible storage. The database shall retain the resulting authorized file reference or URL.

### 3.2.4 Map Services

The frontend shall use Leaflet-compatible map tiles and geographic boundary data to present barangay boundaries and vehicle hubs.

## 3.3 Communications Interfaces

- Production traffic shall use HTTPS.
- API communication shall use standard HTTP methods and JSON payloads.
- Cross-origin access shall be limited to configured trusted origins.
- The system shall not expose credentials or secret storage keys to the browser.

---

# 4. Functional Requirements

Requirement priorities use the following definitions:

- **Must:** required for the accepted system baseline
- **Should:** important but may have a documented workaround
- **Could:** desirable enhancement

## 4.1 Authentication and Account Management

| ID | Requirement | Priority |
|---|---|---|
| FR-AUTH-001 | The system shall allow an eligible user to register using the required identity, barangay, contact, and registration-code information. | Must |
| FR-AUTH-002 | The system shall limit registration attempts to reduce automated abuse. | Must |
| FR-AUTH-003 | The system shall allow approved and active users to log in using valid credentials. | Must |
| FR-AUTH-004 | The system shall reject invalid credentials without revealing whether a specific email address exists. | Must |
| FR-AUTH-005 | The system shall issue a Sanctum access token after successful authentication. | Must |
| FR-AUTH-006 | The system shall allow the authenticated user to log out and revoke the active token. | Must |
| FR-AUTH-007 | The system shall prevent deactivated users from accessing protected functions. | Must |
| FR-AUTH-008 | The system shall allow a user to view and update permitted profile fields. | Must |
| FR-AUTH-009 | The system shall require the current password before accepting a password change. | Must |
| FR-AUTH-010 | Development impersonation functions shall return unavailable in production environments. | Must |

## 4.2 Barangay Registration and Tenant Isolation

| ID | Requirement | Priority |
|---|---|---|
| FR-TEN-001 | The system shall associate ordinary users with one barangay. | Must |
| FR-TEN-002 | The system shall associate fleet records with the appropriate barangay directly or through a barangay-owned vehicle. | Must |
| FR-TEN-003 | The system shall prevent ordinary users from viewing or changing another barangay’s fleet data. | Must |
| FR-TEN-004 | The system shall provide province, city or municipality, and barangay lookup data for registration. | Must |
| FR-TEN-005 | The system shall support a barangay-specific staff registration code. | Must |
| FR-TEN-006 | An authorized Admin or Super Admin shall be able to regenerate the applicable registration code. | Must |
| FR-TEN-007 | Registration status lookups shall be read-only and rate-limited. | Must |

## 4.3 User and Role Administration

| ID | Requirement | Priority |
|---|---|---|
| FR-USR-001 | The Admin shall be able to list users belonging to the same barangay. | Must |
| FR-USR-002 | The Admin shall be able to create and update authorized barangay user accounts. | Must |
| FR-USR-003 | The Admin shall be able to activate or deactivate barangay users. | Must |
| FR-USR-004 | The system shall support Admin, Custodian, and Maintenance Personnel roles. | Must |
| FR-USR-005 | The system shall support one primary role and optional additional roles for a user. | Must |
| FR-USR-006 | Server-side authorization shall accept a user acting under any valid assigned role. | Must |
| FR-USR-007 | User deactivation shall not erase historical attribution from fleet records and logs. | Must |

## 4.4 Super Admin Functions

| ID | Requirement | Priority |
|---|---|---|
| FR-SA-001 | The Super Admin shall be able to list registered barangays and user accounts. | Must |
| FR-SA-002 | The Super Admin shall be able to activate or deactivate user accounts. | Must |
| FR-SA-003 | The Super Admin shall be able to update permitted user roles. | Must |
| FR-SA-004 | The Super Admin shall be able to view and regenerate barangay registration codes. | Must |
| FR-SA-005 | The Super Admin shall be able to view platform-level activity information allowed by policy. | Must |
| FR-SA-006 | The Super Admin shall be able to review, resolve, reopen, or remove public concern reports as authorized. | Must |
| FR-SA-007 | Middleware shall restrict the Super Admin from ordinary barangay fleet routes. | Must |

## 4.5 Vehicle Type and Catalog Management

| ID | Requirement | Priority |
|---|---|---|
| FR-CAT-001 | An authorized user shall be able to create, edit, list, and delete eligible vehicle types. | Must |
| FR-CAT-002 | A vehicle type shall include a unique name and a Land or Water domain. | Must |
| FR-CAT-003 | The system shall prevent deletion of reference data when doing so would violate record integrity. | Must |
| FR-CAT-004 | Authorized users shall be able to maintain fault-category and maintenance-type catalogs. | Must |
| FR-CAT-005 | Catalog values shall be normalized to reduce duplicate names. | Should |

## 4.6 Vehicle Inventory and Lifecycle

| ID | Requirement | Priority |
|---|---|---|
| FR-VEH-001 | The Admin shall be able to register a vehicle with its identity, category, plate number, brand, model, model year, capacity, color, location, and applicable details. | Must |
| FR-VEH-002 | Plate numbers shall be unique within the enforced database scope. | Must |
| FR-VEH-003 | The system shall capture land or water-specific data according to vehicle category. | Must |
| FR-VEH-004 | Water vehicles may include hull material and engine type. | Must |
| FR-VEH-005 | The system shall allow an authorized user to upload or update a vehicle photo. | Should |
| FR-VEH-006 | The system shall allow users to view a vehicle profile containing status, condition, location, records, documents, and history. | Must |
| FR-VEH-007 | The Admin shall be able to edit permitted vehicle information without silently overwriting workflow-controlled state. | Must |
| FR-VEH-008 | The Admin shall be able to archive an active vehicle and later restore it when allowed. | Must |
| FR-VEH-009 | Archived vehicles shall be excluded from active operational selection lists. | Must |
| FR-VEH-010 | The Admin shall be able to decommission a vehicle with a required reason. | Must |
| FR-VEH-011 | The system shall block decommissioning while the vehicle has an unresolved maintenance ticket. | Must |
| FR-VEH-012 | A decommissioned vehicle shall be excluded from readiness and coverage calculations. | Must |
| FR-VEH-013 | Vehicle history shall remain available after archive or decommission actions. | Must |
| FR-VEH-014 | An authorized Admin may recommission a decommissioned vehicle when business rules permit. | Should |

## 4.7 Vehicle Documents

| ID | Requirement | Priority |
|---|---|---|
| FR-DOC-001 | The system shall allow authorized users to attach documents to a vehicle. | Must |
| FR-DOC-002 | Each document shall record a title, optional category, file reference, uploader, and timestamps. | Must |
| FR-DOC-003 | Authorized users shall be able to update document metadata and delete eligible documents. | Must |
| FR-DOC-004 | The current release shall not claim automatic document-expiry compliance unless expiry fields and rules are separately implemented. | Must |

## 4.8 Availability, Condition, and Readiness

| ID | Requirement | Priority |
|---|---|---|
| FR-RDY-001 | The system shall store vehicle availability separately from physical condition. | Must |
| FR-RDY-002 | Supported availability states shall include Available, Under Maintenance, Inactive, and Decommissioned; transitional legacy values shall be handled consistently. | Must |
| FR-RDY-003 | Supported condition values shall include Good, Needs Inspection, Needs Repair, and Damaged. | Must |
| FR-RDY-004 | An authorized Admin or Custodian shall be able to perform a readiness check. | Must |
| FR-RDY-005 | A readiness check shall store checklist results, overall result, checker identity, attestation where required, notes, and time. | Must |
| FR-RDY-006 | Any failed required checklist item shall cause the readiness result to fail. | Must |
| FR-RDY-007 | A passed readiness check shall be treated as current for 24 hours under the configured baseline policy. | Must |
| FR-RDY-008 | After the freshness period, the system shall label the prior readiness evidence stale rather than silently treating it as current. | Must |
| FR-RDY-009 | A vehicle that has never been checked shall be visibly identified. | Must |
| FR-RDY-010 | Readiness status shall not override an Under Maintenance, Inactive, or Decommissioned availability state. | Must |
| FR-RDY-011 | The system shall preserve prior readiness checks as history. | Must |

## 4.9 Condition Monitoring

| ID | Requirement | Priority |
|---|---|---|
| FR-CON-001 | An authorized user shall be able to record a dated physical-condition check. | Must |
| FR-CON-002 | A condition check shall record the vehicle, result, observations, checker, and timestamps. | Must |
| FR-CON-003 | The latest valid condition check shall update or inform the vehicle’s current condition. | Must |
| FR-CON-004 | Condition-check history shall remain searchable and filterable. | Must |
| FR-CON-005 | When configured workflow conditions are met, a condition finding may create or link to a resulting maintenance ticket. | Should |

## 4.10 Vehicle Issue Reporting

| ID | Requirement | Priority |
|---|---|---|
| FR-ISS-001 | A Custodian or otherwise authorized user shall be able to report a vehicle issue. | Must |
| FR-ISS-002 | An issue report shall record vehicle, issue type, description, severity, reporter, status, and timestamps. | Must |
| FR-ISS-003 | The report may contain a supported photo attachment. | Should |
| FR-ISS-004 | Severity shall support Low, Medium, High, and Critical values. | Must |
| FR-ISS-005 | Issue status shall support Pending, Under Review, In Maintenance, and Resolved. | Must |
| FR-ISS-006 | An unresolved issue shall affect or flag the vehicle condition according to workflow rules. | Must |
| FR-ISS-007 | The Admin shall be able to convert an issue report into a maintenance ticket. | Must |
| FR-ISS-008 | The system shall prevent new operational issue reports against retired vehicles. | Must |
| FR-ISS-009 | Authorized users shall be able to view a vehicle’s open issues. | Must |

## 4.11 Maintenance Ticket Workflow

### 4.11.1 Ticket Creation and Inspection

| ID | Requirement | Priority |
|---|---|---|
| FR-TKT-001 | The Admin shall be able to create a maintenance ticket representing one Main Issue. | Must |
| FR-TKT-002 | A ticket shall identify the vehicle, title, description, priority, creator, assigned custodian, and optional originating issue report. | Must |
| FR-TKT-003 | Ticket priority shall support Low, Medium, High, and Critical values. | Must |
| FR-TKT-004 | Ticket status shall support Open, Active, Closed, and Cancelled. | Must |
| FR-TKT-005 | The system shall prevent duplicate open Main Issues with equivalent normalized titles on the same vehicle. | Must |
| FR-TKT-006 | The assigned Custodian shall be able to submit the physical inspection result and notes. | Must |
| FR-TKT-007 | Inspection results shall support No Issues and Needs Maintenance. | Must |
| FR-TKT-008 | When maintenance is required, the inspection shall create one or more specific sub-issues. | Must |
| FR-TKT-009 | Confirmed maintenance findings shall place the vehicle Under Maintenance and mark its condition appropriately. | Must |
| FR-TKT-010 | Authorized users shall be able to append a newly discovered sub-issue while the ticket remains eligible. | Must |

### 4.11.2 Work Assignment and Repair

| ID | Requirement | Priority |
|---|---|---|
| FR-TKT-011 | Each sub-issue shall have an independent status and assigned mechanic. | Must |
| FR-TKT-012 | Sub-issue status shall support Open, Under Repair, For Inspection, For Confirmation, Done, and Deferred. | Must |
| FR-TKT-013 | The Admin shall assign an eligible Maintenance Personnel user to each repairable sub-issue. | Must |
| FR-TKT-014 | A mechanic assignment shall include maintenance type and optional work-order notes. | Must |
| FR-TKT-015 | The Admin shall be able to reassign an Under Repair item with a recorded reason. | Must |
| FR-TKT-016 | The Admin shall be able to reassign an unavailable Custodian when workflow rules allow. | Must |
| FR-TKT-017 | Assigned Maintenance Personnel shall record repair logs, parts used, dates, and maintenance cost where applicable. | Must |
| FR-TKT-018 | Completed repair work shall move to For Inspection rather than directly to Done. | Must |

### 4.11.3 Verification and Confirmation

| ID | Requirement | Priority |
|---|---|---|
| FR-TKT-019 | The assigned Custodian shall verify submitted repair work. | Must |
| FR-TKT-020 | Verification shall include an applicable functional test, result, notes, verifier, attestation, and timestamp. | Must |
| FR-TKT-021 | Rejected verification shall return the sub-issue for additional repair. | Must |
| FR-TKT-022 | Approved verification shall move the sub-issue to For Confirmation. | Must |
| FR-TKT-023 | The Admin shall issue the final Confirmed or Reopened decision. | Must |
| FR-TKT-024 | Confirmed sub-issues shall be marked Done and recorded in maintenance history. | Must |
| FR-TKT-025 | The Admin shall be able to reopen a previously confirmed sub-issue with a required reason when allowed. | Must |

### 4.11.4 Closure, Deferral, Cancellation, and Archive

| ID | Requirement | Priority |
|---|---|---|
| FR-TKT-026 | Normal ticket closure shall be allowed when every sub-issue is resolved. | Must |
| FR-TKT-027 | The Admin may defer unfinished work only with a recorded reason. | Must |
| FR-TKT-028 | Deferral shall create a follow-up issue-report breadcrumb so unfinished work remains visible. | Must |
| FR-TKT-029 | A decision-close with unfinished work shall require an explicit fit-for-service answer. | Must |
| FR-TKT-030 | If the vehicle is not fit for service, closing the ticket shall leave it Under Maintenance. | Must |
| FR-TKT-031 | Closing one ticket shall not return the vehicle to Available while another open ticket remains. | Must |
| FR-TKT-032 | Only the controlled closing or other explicitly authorized lifecycle operation shall return a repaired vehicle to Available. | Must |
| FR-TKT-033 | The Admin shall be able to cancel and, where allowed, uncancel a ticket. | Must |
| FR-TKT-034 | Deleting a ticket with meaningful progress shall preserve a recoverable archive snapshot as defined by policy. | Must |
| FR-TKT-035 | Closed ticket archives shall remain locked against ordinary editing. | Must |
| FR-TKT-036 | A Deleted archive may be reopened only when duplicate and integrity rules permit. | Must |
| FR-TKT-037 | Tickets open beyond the configured aging threshold shall be visibly flagged. | Should |

## 4.12 Direct Maintenance Records

| ID | Requirement | Priority |
|---|---|---|
| FR-MNT-001 | Authorized users shall be able to record maintenance performed outside the full ticket workflow. | Must |
| FR-MNT-002 | A maintenance record shall store vehicle, maintenance type, reason, dates, performer, work performed, parts, cost, status, and notes as applicable. | Must |
| FR-MNT-003 | The performer may be an internal Maintenance Personnel user or an identified external performer. | Must |
| FR-MNT-004 | Applicable maintenance records shall pass through verification and confirmation controls. | Must |
| FR-MNT-005 | A failed verification or declined confirmation shall return the record to the proper earlier state. | Must |
| FR-MNT-006 | Decision-close behavior shall require reasons and a fit-for-service decision when unfinished work remains. | Must |
| FR-MNT-007 | A completed and confirmed record shall contribute to vehicle maintenance history and reliability calculations. | Must |

## 4.13 Preventive-Maintenance Scheduling

| ID | Requirement | Priority |
|---|---|---|
| FR-PM-001 | An authorized Admin or Maintenance Personnel user shall be able to create a preventive-maintenance schedule. | Must |
| FR-PM-002 | A schedule shall record vehicle, maintenance type, date, optional time, service location, notes, creator, and optional assignee. | Must |
| FR-PM-003 | Schedule status shall support Scheduled, Completed, and Cancelled. | Must |
| FR-PM-004 | The system shall prevent duplicate scheduled maintenance for the same vehicle on the same date when the business rule applies. | Must |
| FR-PM-005 | A schedule may recur monthly, quarterly, every six months, yearly, or at another supported month interval. | Must |
| FR-PM-006 | Completing a schedule shall create the corresponding proof-of-work maintenance record. | Must |
| FR-PM-007 | Completing a recurring schedule shall generate the next occurrence based on the completion date and recurrence interval. | Must |
| FR-PM-008 | Authorized users shall be able to edit, cancel or delete, and restore eligible schedules. | Must |
| FR-PM-009 | The dashboard shall identify upcoming and overdue scheduled maintenance. | Must |

## 4.14 Vehicle Locations and Hubs

| ID | Requirement | Priority |
|---|---|---|
| FR-LOC-001 | The Admin shall be able to create, edit, hide, and remove eligible vehicle hubs. | Must |
| FR-LOC-002 | A hub shall contain a name, map coordinates, barangay association, and applicable display metadata. | Must |
| FR-LOC-003 | Hubs shall be constrained to valid coordinates and applicable barangay-boundary rules. | Must |
| FR-LOC-004 | An authorized user shall be able to assign or update a vehicle’s current hub or station. | Must |
| FR-LOC-005 | Each location change shall record the vehicle, location, updater, optional address or remarks, and timestamp. | Must |
| FR-LOC-006 | The map shall display hubs and the number of assigned vehicles. | Must |
| FR-LOC-007 | The system shall provide a searchable tabular location record as an alternative to the map. | Must |
| FR-LOC-008 | Users shall be able to focus the map on a selected vehicle or hub where implemented. | Should |
| FR-LOC-009 | The system shall support map and satellite presentation and map-image download where available. | Should |
| FR-LOC-010 | Location shall be described as station or hub information, not continuous live GPS tracking. | Must |

## 4.15 Dashboard and Fleet Intelligence

| ID | Requirement | Priority |
|---|---|---|
| FR-DASH-001 | The dashboard shall show fleet counts by relevant availability and condition states. | Must |
| FR-DASH-002 | The dashboard shall show emergency readiness and coverage by vehicle type. | Must |
| FR-DASH-003 | The dashboard shall distinguish verified-ready, stale, failed, and never-checked vehicles. | Must |
| FR-DASH-004 | The system shall show expected return-to-service dates where recorded. | Must |
| FR-DASH-005 | The system shall show upcoming preventive maintenance. | Must |
| FR-DASH-006 | The system shall calculate per-vehicle failure counts over supported recent periods. | Must |
| FR-DASH-007 | The system shall calculate average recorded days out of service where sufficient data exists. | Must |
| FR-DASH-008 | The system shall show recorded lifetime maintenance expenditure where sufficient data exists. | Must |
| FR-DASH-009 | The system shall flag chronic or recurring failures based on configured rules. | Must |
| FR-DASH-010 | The system shall identify vehicle types with only one working or ready unit as a single-point-of-failure risk. | Must |
| FR-DASH-011 | The system shall identify recurring failure categories across the fleet. | Must |
| FR-DASH-012 | Metrics with insufficient data shall be labeled unavailable or incomplete rather than fabricated. | Must |

## 4.16 Histories, Logs, and Archives

| ID | Requirement | Priority |
|---|---|---|
| FR-HIS-001 | The system shall maintain a chronological vehicle history of significant events. | Must |
| FR-HIS-002 | Vehicle history shall include applicable inventory, location, issue, condition, readiness, maintenance, archive, and lifecycle actions. | Must |
| FR-HIS-003 | The system shall maintain an activity log identifying user, role, action, module, affected record, details, and time. | Must |
| FR-HIS-004 | Histories and logs shall support search, filtering, and pagination. | Must |
| FR-HIS-005 | Historical attribution shall survive account deactivation and eligible record lifecycle changes. | Must |
| FR-HIS-006 | Archive snapshots shall preserve the ticket state and sub-issues required for audit or permitted recovery. | Must |

## 4.17 Notifications

| ID | Requirement | Priority |
|---|---|---|
| FR-NOT-001 | The system shall generate in-app notifications for applicable workflow handoffs. | Must |
| FR-NOT-002 | Notifications shall identify the recipient, title, message, type, related record where applicable, and read state. | Must |
| FR-NOT-003 | Users shall be able to mark one notification or all notifications as read. | Must |
| FR-NOT-004 | Users shall be able to delete eligible notifications. | Must |
| FR-NOT-005 | Notifications shall not replace the authoritative workflow status stored in the related record. | Must |

## 4.18 Reports and Data Export

| ID | Requirement | Priority |
|---|---|---|
| FR-REP-001 | Authorized users shall be able to access reports relevant to fleet, issues, maintenance, readiness, and history. | Must |
| FR-REP-002 | Reports shall respect barangay and role boundaries. | Must |
| FR-REP-003 | Report filters shall produce consistent results with the source records. | Must |
| FR-REP-004 | The system shall provide printable report previews where supported. | Must |
| FR-REP-005 | The system shall support CSV export for implemented vehicle and schedule datasets. | Must |
| FR-REP-006 | Exported data shall not include fields the requesting user is not authorized to access. | Must |

## 4.19 Public Concern Reports

| ID | Requirement | Priority |
|---|---|---|
| FR-PCR-001 | A public user shall be able to submit a concern without authentication. | Must |
| FR-PCR-002 | A concern shall include its type, description, and optional barangay and reporter contact information. | Must |
| FR-PCR-003 | Public concern submission shall be rate-limited. | Must |
| FR-PCR-004 | The Super Admin shall be able to mark a concern Resolved or reopen it. | Must |
| FR-PCR-005 | Resolution shall record the resolver and resolution time. | Must |

---

# 5. Business Rules

| ID | Rule |
|---|---|
| BR-001 | Availability, condition, and readiness are separate facts and shall not be treated as synonyms. |
| BR-002 | A recent passed readiness check cannot make an Under Maintenance, Inactive, or Decommissioned vehicle dispatchable. |
| BR-003 | A readiness check becomes stale after 24 hours under the baseline configuration. |
| BR-004 | A vehicle with any failed required readiness item is not verified ready. |
| BR-005 | A confirmed defect that requires maintenance shall remove the vehicle from operational availability. |
| BR-006 | One vehicle may have multiple tickets for different Main Issues. |
| BR-007 | The same normalized Main Issue shall not have duplicate open tickets for one vehicle. |
| BR-008 | Each sub-issue progresses independently through assignment, repair, verification, and confirmation. |
| BR-009 | Repair submission does not by itself mark the item Done. |
| BR-010 | Custodian approval does not by itself return the vehicle to service; final confirmation and ticket closure controls still apply. |
| BR-011 | Closing one ticket shall not free the vehicle while another unresolved ticket exists. |
| BR-012 | Deferred work requires a reason and a visible follow-up issue. |
| BR-013 | Decision-close with unfinished work requires an explicit fit-for-service decision. |
| BR-014 | A vehicle declared not fit for service remains Under Maintenance even if the associated ticket is closed. |
| BR-015 | Decommissioning requires a reason and is blocked by unresolved tickets. |
| BR-016 | Decommissioned vehicles are excluded from operational readiness and coverage totals. |
| BR-017 | Completing recurring PM generates its next occurrence from the actual completion date plus the recurrence interval. |
| BR-018 | Archived or retired vehicles shall not appear in normal active-vehicle selectors. |
| BR-019 | Ordinary users may access only the records belonging to their barangay. |
| BR-020 | UI visibility does not replace server-side authorization. |
| BR-021 | An audit record identifies the authenticated actor even when the actor has multiple roles. |
| BR-022 | Historical records shall not be silently rewritten to conceal prior workflow decisions. |

---

# 6. Use-Case Specifications

## UC-01 Authenticate User

| Field | Specification |
|---|---|
| Primary actor | Registered user |
| Preconditions | Account exists, is approved, and is active |
| Trigger | User submits email and password |
| Main flow | System validates input → verifies credentials → issues token → returns profile and role information → loads authorized workspace |
| Alternate flow | Invalid credentials, inactive account, excessive attempts, or server error |
| Postcondition | Authenticated session exists, or access is denied without changing protected data |

## UC-02 Register Vehicle

| Field | Specification |
|---|---|
| Primary actor | Admin |
| Preconditions | Admin is authenticated; category exists |
| Trigger | Admin submits Add Vehicle form |
| Main flow | Enter identity and specifications → validate category/domain fields → verify unique plate → save vehicle → create history and activity log |
| Alternate flow | Duplicate plate, invalid model year, invalid category, failed upload, or missing required field |
| Postcondition | Vehicle is available in the barangay fleet or no record is created |

## UC-03 Perform Readiness Check

| Field | Specification |
|---|---|
| Primary actor | Admin or Custodian |
| Preconditions | Vehicle is active and user is authorized |
| Trigger | User starts readiness inspection |
| Main flow | Load checklist → inspect required items → enter results and notes → attest → submit → system determines pass/fail → store history → update dashboard |
| Alternate flow | Required item omitted, attestation absent, or vehicle is retired |
| Postcondition | Current readiness state is Passed or Failed with actor and timestamp |

## UC-04 Report Vehicle Issue

| Field | Specification |
|---|---|
| Primary actor | Custodian |
| Preconditions | Vehicle is active |
| Trigger | User observes a defect |
| Main flow | Select vehicle → select issue type → enter description and severity → optionally attach photo → submit → system stores report and flags vehicle condition |
| Alternate flow | Invalid attachment, missing description, or retired vehicle |
| Postcondition | Pending issue report exists and is visible to authorized users |

## UC-05 Process Maintenance Ticket

| Field | Specification |
|---|---|
| Primary actors | Admin, Custodian, Maintenance Personnel |
| Preconditions | Active vehicle and authorized users exist |
| Trigger | Admin creates or escalates a Main Issue |
| Main flow | Admin creates and assigns ticket → Custodian inspects and identifies sub-issues → Admin assigns mechanics → Mechanics log repairs → Custodian functionally verifies → Admin confirms → Admin closes ticket → system checks all other tickets before returning vehicle to service |
| Alternate flow | No issues found, failed verification, admin reopens item, mechanic or custodian reassigned, work deferred, decision-close, cancellation, or duplicate Main Issue |
| Postcondition | Ticket remains active with traceable state, or closes with an archive and correct vehicle availability |

## UC-06 Complete Preventive Maintenance

| Field | Specification |
|---|---|
| Primary actor | Admin or Maintenance Personnel |
| Preconditions | Scheduled PM exists |
| Trigger | User marks the scheduled work complete |
| Main flow | Enter completion details → validate evidence → mark schedule completed → create maintenance record → if recurring, create next schedule |
| Alternate flow | Missing completion information, duplicate next date, or cancelled schedule |
| Postcondition | Proof-of-work record exists and future recurrence is scheduled when applicable |

## UC-07 Defer Unfinished Work

| Field | Specification |
|---|---|
| Primary actor | Admin |
| Preconditions | Eligible unresolved sub-issue exists |
| Trigger | Work cannot be completed at present |
| Main flow | Admin selects defer → enters reason → system marks item Deferred → creates follow-up issue → records decision and notifications |
| Alternate flow | Missing reason or ineligible status |
| Postcondition | Work is not presented as completed and remains discoverable through the follow-up issue |

## UC-08 Manage Vehicle Location

| Field | Specification |
|---|---|
| Primary actor | Admin |
| Preconditions | Vehicle and hub exist |
| Trigger | Admin changes assigned location |
| Main flow | Select vehicle and hub → validate barangay and coordinates → save current location → append location history → update map count |
| Alternate flow | Invalid hub, out-of-boundary location, or cross-barangay reference |
| Postcondition | Current station and location history are consistent |

## UC-09 Decommission Vehicle

| Field | Specification |
|---|---|
| Primary actor | Admin |
| Preconditions | Vehicle is active and has no unresolved ticket |
| Trigger | Admin chooses Decommission |
| Main flow | System checks open tickets → Admin enters reason → confirms action → system marks vehicle Decommissioned → excludes it from coverage → preserves history |
| Alternate flow | Open ticket exists or reason is absent |
| Postcondition | Vehicle is retired from operational use or the action is blocked |

---

# 7. Data Requirements

## 7.1 Core Data Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| Province | Geographic registration reference | Has many cities or municipalities |
| City | Geographic registration reference | Belongs to province; has many barangays |
| Barangay | Tenant and operating jurisdiction | Has users, vehicles, hubs, settings, and logs |
| User | Authenticated actor and role holder | Belongs to barangay; referenced by transactions |
| RegistrationSetting | Barangay staff registration code | Belongs to barangay |
| VehicleCategory | Vehicle type and Land/Water domain | Has many vehicles |
| Vehicle | Central fleet asset | Belongs to category and barangay; has issues, checks, tickets, records, documents, locations, and history |
| VehicleHub | Named station with coordinates | Belongs to barangay; used by vehicle locations |
| VehicleLocation | Location-change record | Belongs to vehicle and updater |
| VehicleConditionCheck | Physical-condition observation | Belongs to vehicle and checker |
| VehicleReadinessCheck | Readiness checklist result | Belongs to vehicle and checker |
| VehicleIssueReport | Reported defect or deferred-work breadcrumb | Belongs to vehicle and reporter; may link to ticket |
| MaintenanceTicket | Main Issue workflow container | Belongs to vehicle; has many sub-issues |
| TicketSubIssue | Individual repair work item | Belongs to ticket; assigned to mechanic |
| TicketArchiveLog | Closed/deleted ticket snapshot | References ticket identity and vehicle snapshot data |
| VehicleMaintenanceRecord | Completed, direct, or historical maintenance ledger | Belongs to vehicle; may link to issue and users |
| VehicleMaintenanceSchedule | Planned preventive-maintenance event | Belongs to vehicle and optional assignee |
| VehicleDocument | Uploaded supporting vehicle file | Belongs to vehicle and uploader |
| VehicleHistory | Vehicle-specific chronological event | Belongs to vehicle |
| ActivityLog | System accountability event | References user, barangay, module, and record |
| Notification | Workflow message for a user | May reference a maintenance ticket |
| FaultCategory | Managed defect classification | Used by issue and recurrence logic |
| MaintenanceType | Managed work classification | Used by tickets, records, and schedules |
| ConcernReport | Publicly submitted platform concern | Resolved by Super Admin |

## 7.2 Data Integrity Requirements

| ID | Requirement |
|---|---|
| DR-001 | Primary keys shall uniquely identify records. |
| DR-002 | Foreign keys shall maintain valid relationships or use documented null-on-delete behavior for historical attribution. |
| DR-003 | Plate number and other configured unique fields shall reject duplicates. |
| DR-004 | Monetary values shall use fixed-precision decimal storage and shall not accept negative values. |
| DR-005 | Dates shall be validated for logical order, including start and completion dates. |
| DR-006 | Enum-like workflow values shall be validated against supported values at the API boundary. |
| DR-007 | Cross-barangay references shall be rejected. |
| DR-008 | Historical and archive records shall retain the information required to understand the original action. |
| DR-009 | Uploaded-file metadata shall remain linked to an authorized owning record. |
| DR-010 | System-calculated metrics shall be reproducible from stored source records. |

## 7.3 Data Retention and Deletion

- Deactivation shall be preferred over destructive deletion for user accounts with historical actions.
- Vehicle archive shall be used for temporary removal from operational use.
- Decommission shall preserve the vehicle’s historical record.
- Closed ticket archives shall be retained as audit evidence.
- Deletion shall be limited to authorized correction scenarios and shall preserve required archive or activity information.
- Production retention periods and backup schedules shall be defined by the deploying LGU’s policy.

## 7.4 Data Classification

| Classification | Examples | Handling expectation |
|---|---|---|
| Public reference | Province, city, barangay lookup names | May be exposed through controlled public endpoints |
| Internal operational | Vehicle condition, readiness, location, maintenance schedules | Restricted to authorized users |
| Personal information | Names, emails, contact details, addresses | Protected and limited to legitimate administrative use |
| Security-sensitive | Password hashes, access tokens, registration codes, storage credentials | Never exposed in logs, exports, or client bundles |
| Audit evidence | Activity logs, archives, verification decisions | Protected against unauthorized modification |

---

# 8. Non-Functional Requirements

## 8.1 Security

| ID | Requirement |
|---|---|
| NFR-SEC-001 | Protected endpoints shall require valid authentication. |
| NFR-SEC-002 | Passwords shall be stored using the framework’s approved one-way hashing mechanism. |
| NFR-SEC-003 | Authorization shall be enforced server-side by role and barangay ownership. |
| NFR-SEC-004 | Login, registration, password verification, public concern, and public enumeration endpoints shall be rate-limited as appropriate. |
| NFR-SEC-005 | Request data shall be validated and sanitized for control characters and invalid encoding without relying on destructive HTML stripping. |
| NFR-SEC-006 | Output shall be encoded by the rendering framework to reduce cross-site scripting risk. |
| NFR-SEC-007 | API responses shall apply security headers including content-type protection, frame denial, a restrictive content security policy, referrer policy, and permissions policy where configured. |
| NFR-SEC-008 | Server-identifying headers shall be removed where feasible. |
| NFR-SEC-009 | File uploads shall validate allowed type, size, naming, and destination before acceptance. |
| NFR-SEC-010 | Development-only impersonation shall be unavailable in production. |
| NFR-SEC-011 | Secrets shall be stored in server-side environment configuration and excluded from source control. |
| NFR-SEC-012 | Sensitive data shall not be written to application logs. |
| NFR-SEC-013 | Production deployment shall use HTTPS. |

## 8.2 Performance

| ID | Requirement |
|---|---|
| NFR-PERF-001 | Under normal barangay workload and adequate infrastructure, common list and detail requests should complete within 2 seconds at the API level, excluding external file or map services. |
| NFR-PERF-002 | Dashboard aggregation should complete within 3 seconds for the expected deployment dataset. |
| NFR-PERF-003 | Search and paginated list requests shall use database-side filtering and pagination. |
| NFR-PERF-004 | Frequently filtered foreign keys and status fields shall be indexed where justified by query patterns. |
| NFR-PERF-005 | File uploads shall enforce size limits to protect application availability. |

These are target requirements and shall be validated using representative deployment data and infrastructure.

## 8.3 Availability and Reliability

| ID | Requirement |
|---|---|
| NFR-REL-001 | Multi-record workflow updates shall use transactions where partial success would create inconsistent state. |
| NFR-REL-002 | The system shall prevent duplicate workflow actions caused by repeated or concurrent requests where implemented controls apply. |
| NFR-REL-003 | Failure to send a notification shall not silently corrupt the authoritative maintenance state. |
| NFR-REL-004 | Recoverable errors shall produce clear messages without exposing internal stack traces in production. |
| NFR-REL-005 | The deployment shall maintain scheduled database and file-storage backups under an LGU-approved recovery policy. |
| NFR-REL-006 | Restore procedures shall be tested before production acceptance. |

## 8.4 Usability

| ID | Requirement |
|---|---|
| NFR-USA-001 | Common user tasks shall use consistent terminology and status labels. |
| NFR-USA-002 | Consequential actions shall state their impact before confirmation. |
| NFR-USA-003 | Empty states shall explain what data is missing and, where permitted, how to create it. |
| NFR-USA-004 | Error messages shall identify the corrective action without unnecessary technical jargon. |
| NFR-USA-005 | Date, time, and currency presentation shall be consistent with the configured Philippine locale and Asia/Manila operational context. |

## 8.5 Accessibility

| ID | Requirement |
|---|---|
| NFR-ACC-001 | Forms shall associate labels with controls. |
| NFR-ACC-002 | Keyboard users shall be able to reach and operate primary actions. |
| NFR-ACC-003 | Status shall not be communicated by color alone. |
| NFR-ACC-004 | Text and essential controls should meet WCAG 2.1 AA contrast expectations where practicable. |
| NFR-ACC-005 | Modal dialogs shall manage focus and provide a clear close mechanism. |

## 8.6 Maintainability

| ID | Requirement |
|---|---|
| NFR-MNT-001 | Frontend and backend concerns shall remain separated through the REST interface. |
| NFR-MNT-002 | Database changes shall be managed through versioned migrations. |
| NFR-MNT-003 | Business-critical workflow rules shall be covered by automated tests. |
| NFR-MNT-004 | Configuration values shall not be hard-coded when they vary by environment. |
| NFR-MNT-005 | Code changes shall preserve existing unrelated behavior and data migrations shall provide a rollback path where feasible. |
| NFR-MNT-006 | API and workflow documentation shall be updated when behavior changes. |

## 8.7 Portability and Compatibility

| ID | Requirement |
|---|---|
| NFR-PORT-001 | The client shall support current versions of major Chromium-, Firefox-, and WebKit-based browsers. |
| NFR-PORT-002 | The backend shall remain deployable on a compatible PHP and relational-database environment. |
| NFR-PORT-003 | Environment-specific origins, storage, mail, and database settings shall be configurable without source-code changes. |

## 8.8 Privacy

| ID | Requirement |
|---|---|
| NFR-PRIV-001 | The system shall collect only personal information necessary for authentication, accountability, and administration. |
| NFR-PRIV-002 | Users shall not gain access to personal or fleet data outside their authorized scope. |
| NFR-PRIV-003 | Reports and exports shall minimize personal data and honor authorization. |
| NFR-PRIV-004 | Public concern contact details shall be visible only to authorized administrators. |
| NFR-PRIV-005 | Production privacy notices, retention periods, and access procedures shall follow applicable LGU and Philippine data-protection policy. |

---

# 9. Workflow State Models

## 9.1 Maintenance Ticket

```text
Open ──inspection with issues──> Active ──all work resolved/decision-close──> Closed
  │                                │
  └──────────── cancel ────────────┴──────────────────────────────────────> Cancelled
```

## 9.2 Ticket Sub-Issue

```text
Open
  ↓ assign
Under Repair
  ↓ submit repairs
For Inspection
  ├─ reject ───────────────> Under Repair
  └─ approve
       ↓
For Confirmation
  ├─ reopen ───────────────> Under Repair / For Inspection as controlled
  └─ confirm ──────────────> Done

Eligible unresolved work ──defer with reason──> Deferred
```

## 9.3 Issue Report

```text
Pending → Under Review → In Maintenance → Resolved
```

## 9.4 Preventive-Maintenance Schedule

```text
Scheduled → Completed
    └─────→ Cancelled
```

## 9.5 Vehicle Lifecycle

```text
Available ↔ Under Maintenance
    ↓              ↓
 Inactive      Decommissioned

Archive is reversible administrative removal.
Decommission represents end-of-life retirement unless authorized recommissioning occurs.
```

---

# 10. Role-Permission Summary

| Capability | Super Admin | Admin | Custodian | Maintenance Personnel |
|---|:---:|:---:|:---:|:---:|
| Manage cross-barangay accounts | Yes | No | No | No |
| View own barangay fleet | No | Yes | Yes | Yes |
| Register or edit vehicles | No | Yes | No | No |
| Archive/decommission vehicle | No | Yes | No | No |
| Manage vehicle types and hubs | No | Yes | No | No |
| Report vehicle issue | No | As allowed | Yes | View/as allowed |
| Create maintenance ticket | No | Yes | No | No |
| Inspect Main Issue | No | No | Assigned Custodian | No |
| Assign or reassign mechanic | No | Yes | No | No |
| Perform repair work | No | No | No | Assigned Mechanic |
| Verify repair | No | No | Assigned Custodian | No |
| Confirm repair and close ticket | No | Yes | No | No |
| Perform readiness check | No | Yes | Yes | No unless separately authorized |
| Create preventive schedule | No | Yes | View/as allowed | Yes |
| View reports and logs | Platform only | Barangay scope | Limited | Limited |

Exact permission enforcement remains defined by backend authorization rules. A multi-role user receives the union of permissions for assigned roles.

---

# 11. Reporting and Metric Definitions

| Metric | Definition |
|---|---|
| Verified readiness rate | Active vehicles with a current passed readiness check divided by active fleet count |
| Readiness-check compliance | Checks completed within the required period divided by checks required |
| Preventive-maintenance compliance | PM tasks completed by their due dates divided by PM tasks due |
| Fleet availability rate | Available vehicle time divided by total active fleet time, when time-series data is sufficient |
| Mean downtime | Total recorded out-of-service duration divided by completed downtime events |
| Repeat-failure count | Repeated issues in the same normalized category within the configured period |
| Repair turnaround time | Time from work assignment or repair start to verified or confirmed completion, as defined by the report |
| Single-point-of-failure count | Vehicle types with only one working or verified-ready unit |
| Lifetime maintenance spend | Sum of valid recorded maintenance costs for a vehicle |

The system shall label the calculation period and source data. Metrics shall not be interpreted as proof of improved emergency response time without a separate study.

---

# 12. Error Handling Requirements

| ID | Requirement |
|---|---|
| ERR-001 | Validation errors shall identify the affected field and corrective action. |
| ERR-002 | Unauthorized requests shall return 401; authenticated but forbidden requests shall return 403 where applicable. |
| ERR-003 | Missing records shall return 404 without disclosing unrelated tenant data. |
| ERR-004 | Invalid state transitions shall return a conflict or validation response explaining the current state. |
| ERR-005 | Concurrent changes shall not produce duplicated assignments, confirmations, closures, or recurrence schedules. |
| ERR-006 | Production responses shall not expose stack traces, SQL, secrets, or filesystem paths. |
| ERR-007 | File-storage failure shall not create a misleading successful attachment record. |
| ERR-008 | Map-service failure shall not prevent access to the tabular vehicle-location record. |

---

# 13. Acceptance Criteria

The release shall be acceptable when all Must requirements designated for the release pass their approved tests and the following critical scenarios are demonstrated:

1. An approved active user can log in and access only authorized modules.
2. A user from one barangay cannot retrieve or alter another barangay’s fleet records.
3. An Admin can register a valid land or water vehicle and duplicate plate numbers are rejected.
4. A Custodian can record a readiness check; any failed required item produces a failed result.
5. A passed readiness check becomes stale after the configured 24-hour period.
6. A reported defect can be escalated into a Main Issue with one or more sub-issues.
7. A mechanic can update only an assigned repair item and submit it for inspection.
8. A failed functional verification returns the sub-issue for repair.
9. A confirmed sub-issue is recorded in maintenance history.
10. A vehicle cannot return to Available while any other unresolved ticket remains.
11. Deferred work requires a reason and produces a follow-up issue record.
12. A not-fit-for-service decision keeps the vehicle Under Maintenance.
13. Completing recurring preventive maintenance creates the proof-of-work record and next schedule.
14. Decommissioning is blocked while an unresolved ticket exists.
15. Decommissioned vehicles are excluded from readiness and coverage totals.
16. Location changes update both the current vehicle location and location history.
17. Role and workflow actions appear in the appropriate history or activity log.
18. Public concern submission is rate-limited and manageable only by authorized Super Admin users.
19. Development impersonation endpoints are unavailable in production.
20. The frontend production build and backend automated critical-path tests complete successfully.

---

# 14. Requirements Traceability Summary

| Objective | Primary requirements | Verification evidence |
|---|---|---|
| Centralize fleet data | FR-VEH, FR-DOC, FR-LOC | Vehicle CRUD, profile, document, and location tests |
| Establish current readiness | FR-RDY, FR-CON | Checklist, expiry, condition, and dashboard tests |
| Control corrective maintenance | FR-ISS, FR-TKT | End-to-end ticket workflow tests |
| Support preventive maintenance | FR-PM, FR-MNT | Schedule, recurrence, and record tests |
| Prevent unsafe return to service | FR-TKT-019–032, BR-009–014 | Verification, closure, deferral, and concurrent-ticket tests |
| Preserve accountability | FR-HIS, FR-NOT, NFR-SEC | Log, history, notification, and authorization tests |
| Protect barangay data | FR-TEN, NFR-SEC | Tenant-isolation and access-control tests |
| Support fleet decisions | FR-DASH, FR-REP | Dashboard calculation and report validation tests |

---

# 15. Testing Requirements

## 15.1 Unit and Feature Testing

Automated tests shall cover, at minimum:

- authentication, approval, and account deactivation;
- role permissions and multi-role behavior;
- tenant or barangay isolation;
- vehicle validation and lifecycle actions;
- readiness and condition rules;
- issue-report transitions;
- ticket state transitions and duplicate prevention;
- mechanic and custodian reassignment;
- verification, confirmation, deferral, and decision-close;
- other-open-ticket return-to-service protection;
- recurring preventive-maintenance generation;
- reliability and dashboard calculations;
- boundary and hub validation;
- file-upload validation; and
- public endpoint rate limits.

## 15.2 Integration Testing

Integration testing shall validate:

- React-to-API authentication;
- form validation and error display;
- upload integration with object storage;
- database transactions and related record creation;
- map rendering with configured boundaries and hubs;
- notification handoffs; and
- export and print output.

## 15.3 User Acceptance Testing

UAT shall be performed by representatives acting as Admin, Custodian, and Maintenance Personnel. Tests shall use realistic emergency-vehicle scenarios and shall confirm both successful flows and blocked unsafe actions.

## 15.4 Security Testing

Security testing shall include:

- unauthenticated access attempts;
- cross-role and cross-barangay access attempts;
- input validation and malicious payload handling;
- upload type and size validation;
- rate-limit verification;
- inactive-account rejection;
- production error-message review; and
- confirmation that secrets and development utilities are unavailable to clients.

---

# 16. Deployment Requirements

- Production environment variables shall be configured outside version control.
- The application key, database credentials, allowed frontend origin, storage credentials, and mail settings shall be set securely.
- Database migrations shall be applied through the supported deployment process.
- HTTPS shall be enabled before real user or operational data is entered.
- CORS shall allow only the approved frontend origin or origins.
- The production environment shall disable debug mode and development impersonation.
- Scheduled backups shall cover both relational data and uploaded files.
- Initial barangay, administrator, category, and lookup configuration shall be verified before launch.
- A rollback and recovery procedure shall be documented.

---

# 17. Known Limitations

1. Readiness depends on human inspection and accurate data entry.
2. The system does not physically test vehicle components.
3. Hub location is not continuous GPS location.
4. Time-based preventive maintenance does not account for actual mileage or engine hours.
5. Maintenance cost analysis is limited to costs entered into the system.
6. Historical metrics may be incomplete until sufficient operational records accumulate.
7. A web system may become temporarily inaccessible during network or hosting outages.
8. Map accuracy depends on the quality of coordinates, boundaries, and third-party tiles.
9. The software supports organizational controls but does not replace professional mechanical, medical, safety, or legal judgment.

---

# 18. Future Enhancements

The following are candidate enhancements and are not baseline requirements:

- mileage- and engine-hour-based maintenance;
- live GPS or telematics integration;
- fuel and energy-use monitoring;
- parts and consumables inventory;
- equipment and medicine expiration tracking;
- QR or NFC vehicle inspection;
- offline-first mobile readiness forms;
- dispatch-system integration;
- automated recall and registration checks;
- configurable checklist designer with approval workflow;
- SMS or email escalation for critical faults;
- digital signatures with stronger identity assurance;
- advanced lifecycle cost and replacement forecasting; and
- inter-barangay mutual-aid resource visibility with explicit access agreements.

---

# 19. Final System Statement

The Barangay Vehicle Management System is a focused emergency-fleet management platform. Its primary contribution is not to conduct dispatch or emergency response, but to establish the information and accountability needed before a dependable response can begin.

The accepted system shall enable authorized personnel to determine which vehicles exist, where they are stationed, what condition they are in, whether their readiness was recently verified, what maintenance remains unresolved, and who is accountable for returning each unit to service.

