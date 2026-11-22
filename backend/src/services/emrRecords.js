'use strict';

/**
 * emrRecords.js
 *
 * Live record reading from a hospital's own (non-FHIR) API: a custom-built
 * system (integration "rest" with customApi) or SmartClinic. Used when a
 * clinician with a grant opens records (routes/records.js).
 *
 * Records are read at view time, converted to display-only FHIR-shaped
 * resources and returned to the viewer. NOTHING IS STORED: the hospital's
 * own database stays the only copy (user decision, 2026-11-18).
 *
 * What to read is a list of "record sources" set in the hospital setup
 * wizard. Each source:
 *
 *   label          e.g. "Lab tests"
 *   resourceType   Encounter | Observation | DiagnosticReport | Condition |
 *                  MedicationRequest | AllergyIntolerance | DocumentReference
 *   path           API path; {patientId} (the EMR's own patient ID, found by
 *                  hospital number), {hospitalNumber}, or {visitId}. A
 *                  {visitId} source is read once per visit from the
 *                  Encounter source (most recent first, at most MAX_VISITS).
 *   listPath       where the list sits in the answer (blank = detected)
 *   patientField   REQUIRED. The field in each record holding the EMR
 *                  patient ID. A record is shown only if it equals this
 *                  patient's ID: some hospital APIs ignore their own
 *                  filters (PSSH does), so this check is never skipped.
 *   titleField, dateField, detailField, statusField, whoField
 *                  where to read each part; a field path ("drug.name"),
 *                  fields joined with " + ", or a template with {field}
 *                  placeholders ("{frequency} for {duration} {duration_unit}").
 *                  Blank = detected (detail: a few short readable fields).
 *   idField        record ID (default id / _id); for the Encounter source
 *                  it is also the {visitId} given to per-visit sources.
 *   resultPath     optional: where the full result of one record is
 *                  (lab/radiology). Fields of the record in braces, e.g.
 *                  "laboratory/test-results/get/{result_id}"; several
 *                  addresses separated by " | " are tried in order. Read
 *                  only when the record has those fields (i.e. a result
 *                  exists), and shown only if the answer names this same
 *                  patient. Every value is shown: name, value, unit, range.
 *
 * Every converted record also carries `details`: all its readable fields
 * (prices, insurance and internal IDs left out), for "Show all details".
 */

const RESOURCE_TYPES = ['Encounter', 'Observation', 'DiagnosticReport', 'Condition', 'MedicationRequest', 'AllergyIntolerance', 'DocumentReference'];
const SOURCE_FIELDS = ['label', 'resourceType', 'path', 'listPath', 'patientField', 'patientMatch', 'idField', 'titleField', 'dateField', 'detailField', 'statusField', 'whoField', 'resultPath', 'resultMatch', 'excludeFields', 'joinField', 'joinList'];
const MAX_RESULT_READS = 400;
const MAX_SOURCES = 60;
const MAX_VISITS = 25;
const MAX_RECORDS_PER_SOURCE = 1000;
const FIELD_SPEC = /^[\w.$ +{}\-:;,()/·]*$/;

// PSSH (Plateau State Specialist Hospital) record layout, read from its own
// web app and checked against its API on 2026-11-18. Offered in the UI as a
// one-click starting point for that hospital.
const RECORD_PRESETS = Object.freeze({
  pssh: {
    system: 'rest',
    label: 'PSSH (Plateau State Specialist Hospital)',
    patientIdField: 'id',
    staffLookupPath: 'staffs/{id}',
    sources: [
      {
        label: 'Visits',
        resourceType: 'Encounter',
        path: 'visits/all/get?search={hospitalNumber}&currentPage=1&pageLimit=50',
        patientField: 'patient_id',
        titleField: '{department} · {professional}',
        dateField: 'date_visit_start',
        detailField: '{category} · {type} · {priority}',
        statusField: 'status',
        whoField: 'staff.fullname',
      },
      {
        label: 'Lab tests',
        resourceType: 'Observation',
        path: 'visits/prescriptions/{visitId}',
        listPath: 'data.tests',
        patientField: 'patient_id',
        titleField: 'test.name',
        dateField: 'date_requested',
        detailField: 'result',
        statusField: 'result_status',
        whoField: 'examiner.fullname',
        resultPath: 'laboratory/test-results/get/{result_id} | laboratory/test-results/get/{test_prescription_id}',
      },
      {
        label: 'Medications',
        resourceType: 'MedicationRequest',
        path: 'visits/prescriptions/{visitId}',
        listPath: 'data.drugs',
        patientField: 'patient_id',
        titleField: 'drug.name',
        dateField: 'date_prescribed',
        detailField: '{prescribed_strength}{strength.name} {dosage_form.name} · {route.name} · {frequency} for {duration} {duration_unit} · {notes}',
        statusField: 'dispense_status',
        whoField: 'requester.fullname',
      },
      {
        label: 'Radiology',
        resourceType: 'DiagnosticReport',
        path: 'visits/prescriptions/{visitId}',
        listPath: 'data.investigations',
        patientField: 'patient_id',
        titleField: '{investigation.name} · {imaging.name}',
        dateField: 'date_requested',
        detailField: 'result',
        statusField: 'status',
        whoField: 'examiner.fullname',
        resultPath: 'radiology/investigations-results/get/{result_id} | radiology/investigations-results/get/{investigation_prescription_id}',
      },
      {
        label: 'Diagnoses',
        resourceType: 'Condition',
        path: 'consultations/diagnoses/get/{visitId}',
        listPath: 'data.diagnoses',
        patientField: 'patient_id',
        titleField: '',
        dateField: 'createdAt',
        detailField: '',
        statusField: '',
        whoField: 'staff.fullname',
      },
    ],
  },
  // SmartClinic (Primed E-Health), e.g. JUTH: everything SmartClinic holds
  // for the patient, read from SmartClinic's own screens' calls and checked
  // against JUTH on 2026-11-18 (field names only). Diagnoses are kept in
  // their own kinds of record, so a patient who shares notes but not
  // diagnoses never has a diagnosis shown.
  smartclinic: {
    system: 'smartclinic',
    label: 'SmartClinic (Primed E-Health)',
    patientIdField: '_id',
    sources: [
      {
        label: 'Visits',
        resourceType: 'Encounter',
        path: 'consultation/fetch-consultations?hospital_number={hospitalNumber}&limit=100',
        listPath: 'result',
        patientField: 'patient._id',
        titleField: '{appointment.service_name} · {department_route}',
        dateField: 'created_at',
        detailField: '{appointment.appointment_type} · {appointment.appointment_category}',
        statusField: 'status',
        whoField: 'raised_by_name',
        excludeFields: 'complaint,complaintII,complaint_duration,complaint_history,confirmed_diagnosis,uncoded_diagnosis,diagnosis,extra_diagnosis,examination,full_examination,notes,systemic_review,lab_requests,radiology_requests,pharmacy_requests,consultation_history,partograph,icd_code_version,coded',
      },
      {
        label: 'Consultation notes',
        resourceType: 'DocumentReference',
        path: 'consultation/fetch-consultations?hospital_number={hospitalNumber}&limit=100',
        listPath: 'result',
        patientField: 'patient._id',
        titleField: 'Consultation · {department_route}',
        dateField: 'created_at',
        detailField: 'Complaint: {complaintII} {complaint} · Complaint history: {complaint_history} · Examination: {examination} · Plan: {notes} · Other information: {other_information} · Review of systems: {systemic_review}',
        whoField: 'raised_by_name',
        excludeFields: 'confirmed_diagnosis,uncoded_diagnosis,diagnosis,extra_diagnosis,icd_code_version,coded,lab_requests,radiology_requests,pharmacy_requests,consultation_history,partograph,appointment,notes,complaintII,complaint,complaint_history,examination,other_information,systemic_review',
      },
      {
        label: 'Diagnoses',
        resourceType: 'Condition',
        path: 'consultation/fetch-consultations?hospital_number={hospitalNumber}&limit=100',
        listPath: 'result[].uncoded_diagnosis',
        patientField: '_parent.patient._id',
        titleField: 'value',
        dateField: '_parent.created_at',
        whoField: '_parent.raised_by_name',
      },
      {
        label: 'Initial assessment',
        resourceType: 'Condition',
        path: 'consultation/fetch-consultations?hospital_number={hospitalNumber}&limit=100',
        listPath: 'result[].extra_diagnosis',
        patientField: '_parent.patient._id',
        titleField: 'value',
        dateField: '_parent.created_at',
        whoField: '_parent.raised_by_name',
      },
      {
        label: 'Diagnoses (coded)',
        resourceType: 'Condition',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_consultation_records[].confirmed_diagnosis',
        patientField: '_parent.patient',
        titleField: '{desc}{title}',
        dateField: '_parent.created_at',
        detailField: 'ICD code {code}{theCode}',
        excludeFields: 'px_categories,lab_categories,rad_categories,locked,id,stemId,isLeaf,postcoordinationAvailability,hasCodingNote,hasMaternalChapterLink,hasPerinatalChapterLink,matchingPVs,propertiesTruncated,isResidualOther,isResidualUnspecified,chapter,score,titleIsASearchResult,titleIsTopScore,entityType,important,descendants',
      },
      {
        label: 'Diagnoses (working)',
        resourceType: 'Condition',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_consultation_records[].diagnosis',
        patientField: '_parent.patient',
        titleField: '{desc}{title}',
        dateField: '_parent.created_at',
        detailField: 'ICD code {code}{theCode}',
        excludeFields: 'px_categories,lab_categories,rad_categories,locked,id,stemId,isLeaf,postcoordinationAvailability,hasCodingNote,hasMaternalChapterLink,hasPerinatalChapterLink,matchingPVs,propertiesTruncated,isResidualOther,isResidualUnspecified,chapter,score,titleIsASearchResult,titleIsTopScore,entityType,important,descendants',
      },
      {
        label: 'Medical history: Past medical history',
        resourceType: 'Condition',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.medical_history',
        patientField: '_parent._id',
        titleField: 'Past medical history',
      },
      {
        label: 'Medical history: Previous surgical history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.surgery_history',
        patientField: '_parent._id',
        titleField: 'Previous surgical history',
      },
      {
        label: 'Medical history: Obstetric and gynae history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.obstetrics_history',
        patientField: '_parent._id',
        titleField: 'Obstetric and gynae history',
      },
      {
        label: 'Medical history: Neonatal history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.neonatal_history',
        patientField: '_parent._id',
        titleField: 'Neonatal history',
      },
      {
        label: 'Medical history: Social history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.social_history',
        patientField: '_parent._id',
        titleField: 'Social history',
      },
      {
        label: 'Medical history: Family history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.family_history',
        patientField: '_parent._id',
        titleField: 'Family history',
      },
      {
        label: 'Medical history: Psychiatric history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.psychiatric_history',
        patientField: '_parent._id',
        titleField: 'Psychiatric history',
      },
      {
        label: 'Medical history: Dental history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.dental_history',
        patientField: '_parent._id',
        titleField: 'Dental history',
      },
      {
        label: 'Medical history: Nutritional history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.nutritional_history',
        patientField: '_parent._id',
        titleField: 'Nutritional history',
      },
      {
        label: 'Medical history: Developmental milestones',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.developmental_milestone',
        patientField: '_parent._id',
        titleField: 'Developmental milestones',
      },
      {
        label: 'Medical history: History (BBL)',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.bbl',
        patientField: '_parent._id',
        titleField: 'History (BBL)',
      },
      {
        label: 'Medical history: Breast history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.breast',
        patientField: '_parent._id',
        titleField: 'Breast history',
      },
      {
        label: 'Medical history: Other history',
        resourceType: 'DocumentReference',
        path: 'records/patient/single?data=%7B%22_id%22%3A%22{patientId}%22%7D',
        listPath: 'result[].consultation_history.consultation_history_II',
        patientField: '_parent._id',
        titleField: 'Other history',
      },
      {
        label: 'Appointments',
        resourceType: 'Encounter',
        path: 'new-aggregate/all-patient-appointment/{patientId}',
        listPath: 'result',
        patientField: 'patient',
        titleField: '{service_name} · {department_route}',
        dateField: 'appointment_time',
        detailField: '{appointment_type} · {appointment_category} · {consultation_type}',
        statusField: 'status',
        whoField: 'doctor_name',
        excludeFields: 'patient_smart_code,department',
      },
      {
        label: 'Allergies (drugs)',
        resourceType: 'AllergyIntolerance',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result[].consultation_history.special_precaution.drug_allergies',
        patientField: '_parent._id',
        titleField: 'drug_name',
      },
      {
        label: 'Allergies (other)',
        resourceType: 'AllergyIntolerance',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result[].consultation_history.special_precaution.other_allergies',
        patientField: '_parent._id',
        titleField: 'name',
        detailField: 'Reaction: {reaction}',
      },
      {
        label: 'Vital signs',
        resourceType: 'Observation',
        path: 'nursing-station/patient-vitals?hospital_number={hospitalNumber}',
        listPath: 'result',
        patientField: 'patient',
        titleField: '',
        dateField: 'created_at',
        detailField: 'BP {blood_pressure} · Temperature {temperature} · Weight {weight} · Left eye {left_eye} · Right eye {right_eye}',
        whoField: '{recorded_by.fname} {recorded_by.lname}',
      },
      {
        label: 'Lab tests',
        resourceType: 'Observation',
        path: 'lab/fetch-lab-requests?patient_id={patientId}',
        listPath: 'result[].requests',
        patientField: '_parent.patient._id',
        titleField: 'test.service_name',
        dateField: '_parent.created_at',
        statusField: 'status',
        whoField: '{_parent.raised_by.fname} {_parent.raised_by.lname}',
        excludeFields: 'test,uuid,sent_to_mobile,bill_generated,exempt,is_pay_later,result',
        resultPath: 'lab/lab-results?appointment={_parent.appointment._id}',
        resultMatch: 'request=_id',
      },
      {
        label: 'Radiology requests',
        resourceType: 'DiagnosticReport',
        path: 'radiology/v2/fetch-requests?hospital_number={hospitalNumber}&limit=500',
        listPath: 'result[].requests',
        patientField: '_parent.patient._id',
        titleField: 'test.service_name',
        dateField: '_parent.created_at',
        detailField: '{_parent.general_instruction}',
        statusField: 'status',
        whoField: '{_parent.raised_by.fname} {_parent.raised_by.lname}',
        excludeFields: 'test,uuid,sent_to_mobile,is_paid,is_pay_later,exempt',
      },
      {
        label: 'Radiology reports',
        resourceType: 'DiagnosticReport',
        path: 'radiology/v2/fetch-result?skip_date_filter=yes&hospital_number={hospitalNumber}',
        listPath: 'result',
        patientField: 'hospital_number',
        patientMatch: 'hospitalNumber',
        titleField: 'test.service_name',
        dateField: 'date_created',
        excludeFields: 'key,request,test,fullName,gender,appointment,date_updated,report',
      },
      {
        label: 'Radiology results',
        resourceType: 'DiagnosticReport',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_radiologyresult_records',
        patientField: 'patient',
        joinField: 'test',
        joinList: 'result.0.radiologyresult_test_details',
        titleField: '_join.service_name',
        dateField: 'created_at',
        detailField: '{summary}',
        statusField: 'current_stage',
        excludeFields: 'images,test,report',
      },
      {
        label: 'Service requests (radiology & other)',
        resourceType: 'DiagnosticReport',
        path: 'service/requests/patient/{patientId}?limit=200',
        listPath: 'data',
        patientField: 'patient',
        titleField: 'services.0.service_name',
        dateField: 'created_at',
        detailField: '{general_instruction}',
        statusField: 'status',
        excludeFields: 'service_results,services,mapped_staff_to_service,raised_for,departments,nyr_patient,diagnosis',
      },
      {
        label: 'Medications',
        resourceType: 'MedicationRequest',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_pharmacyrequest_records[].drugs',
        patientField: '_parent.patient',
        joinField: 'drug',
        joinList: 'result.0.pharmacy_request_drug_details',
        titleField: '_join.item_name',
        dateField: '_parent.created_at',
        detailField: '{prescription} · {frequency} for {duration} {duration_type} · Quantity {quantity} · {_parent.general_instruction}',
        statusField: '_parent.status',
        excludeFields: 'drug,sent_to_mobile,bill_generated,paid,payment_status',
      },
      {
        label: 'Admissions',
        resourceType: 'Encounter',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records',
        patientField: 'patient',
        titleField: 'Admission · {ward_name}{ward.name}',
        dateField: 'admission_time',
        detailField: '{number_of_nights} night(s) · {period_on_admission} · {instruction}',
        statusField: 'status',
        whoField: '{admitted_by_fname} {admitted_by_lname}',
        excludeFields: 'partograph,ward_beds,ward_details,assigned_beds,assigned_bed,bed,daily_report,daily_reports,nursing_history,ward_round,care_plan,discharge_options,is_paid,is_pay_later,ward,provisional_diagnosis,selected_consultant,attached_to,admitted_by,unit,clinic,treatment_chart,emergency,number_of_beds_in_ward,number_of_free_beds_in_ward,is_ward_icu,ward_capacity,cost_per_night,discharge_summary,admitted_by_designation,admitted_by_department_route,admitted_by_gender',
      },
      {
        label: 'Discharge summaries',
        resourceType: 'DocumentReference',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].discharge_summary',
        patientField: '_parent.patient',
        titleField: 'Discharge summary',
        dateField: 'date_of_discharge',
        detailField: 'Status on discharge: {status_on_discharge} · Medications on discharge: {discharge_medications} · Investigations: {relevant_investigation_results} · Clinic appointment: {clinic_appointment}',
        whoField: 'staff_name',
        excludeFields: 'staff',
      },
      {
        label: 'Diagnoses (discharge)',
        resourceType: 'Condition',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].discharge_summary.definitive_diagnosis',
        patientField: '_parent.patient',
        titleField: 'value',
      },
      {
        label: 'Provisional diagnoses (admission)',
        resourceType: 'Condition',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].provisional_diagnosis',
        patientField: '_parent.patient',
        titleField: 'value',
        dateField: '_parent.admission_time',
      },
      {
        label: 'Ward round notes',
        resourceType: 'DocumentReference',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].ward_round.initial_ward_round_notes',
        patientField: '_parent.patient',
        titleField: 'Ward round',
        dateField: 'updated_at',
        detailField: 'Complaint: {presenting_complaint} · History: {history_of_presenting_complaint} · Review of systems: {systemic_review} · Examination: {examination} · Plan: {plan}',
        whoField: 'created_by_name',
        excludeFields: 'provisional_diagnosis,created_by_id',
      },
      {
        label: 'Ward round notes (follow-up)',
        resourceType: 'DocumentReference',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].ward_round.follow_up_ward_round_notes',
        patientField: '_parent.patient',
        titleField: 'Ward round (follow-up)',
        dateField: 'updated_at',
        whoField: '{created_by_name}{updated_by_name}',
        excludeFields: 'provisional_diagnosis,diagnosis,created_by_id',
      },
      {
        label: 'Ward round diagnoses',
        resourceType: 'Condition',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].ward_round.initial_ward_round_notes[].provisional_diagnosis',
        patientField: '_parent._parent.patient',
        titleField: 'value',
      },
      {
        label: 'Nursing reports',
        resourceType: 'DocumentReference',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].daily_reports',
        patientField: '_parent.patient',
        titleField: 'Nursing report',
        dateField: 'date_created',
        detailField: 'Situation: {situation} · Background: {background} · Assessment: {assessment} · Recommendation: {recommendation}',
        whoField: 'entry_by_name',
        excludeFields: 'entry_by',
      },
      {
        label: 'Care plans',
        resourceType: 'DocumentReference',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].care_plan',
        patientField: '_parent.patient',
        titleField: 'Care plan',
        dateField: 'date_created',
        detailField: 'Assessment: {assessment} · Objectives: {objectives} · Plan: {plan} · Orders: {orders} · Implementation: {implementation} · Evaluation: {evaluation}',
        whoField: 'entry_by_name',
        excludeFields: 'diagnosis,entry_by',
      },
      {
        label: 'Nursing examinations',
        resourceType: 'Observation',
        path: 'report-system/all-reports-per-patient/{patientId}',
        listPath: 'result.0.all_admission_records[].nursing_history.examinations',
        patientField: '_parent.patient',
        titleField: 'Nursing examination',
        dateField: 'date_created',
        detailField: 'BP {blood_pressure} · Pulse {pulse} · Respiration {respiration} · Temperature {temperature} · Weight {weight} · Height {height} · Apex beat {apex_beat}',
        whoField: 'entry_by_name',
        excludeFields: 'nursing_diagnosis,lab_requests,entry_by',
      },
      {
        label: 'Inpatient treatment chart',
        resourceType: 'MedicationRequest',
        path: 'pharmacy/pharmacy-admission?patient={patientId}',
        listPath: 'result[].admission.treatment_chart',
        patientField: '_parent.patient',
        titleField: 'drug_name',
        dateField: 'date_created',
        detailField: '{prescription} · {route} · every {interval} · {duration} · {instructions} · {comment}',
        whoField: 'generated_by_name',
        excludeFields: 'chart_items,drug,generated_by,trmt_chart_id',
      },
      {
        label: 'Surgery records',
        resourceType: 'DocumentReference',
        path: 'surgery/surgery-records/all?patientId={patientId}',
        listPath: 'data',
        patientField: 'patient._id',
        titleField: 'Surgery · {department_route}',
        dateField: 'created_at',
        detailField: 'Operation notes: {operation_notes} · Post-operative orders: {post_operation_orders} · Anaesthesia: {anaesthetics_note}',
        statusField: 'status',
        excludeFields: 'patient_images,staff,instruments_count,request,anaesthetics_details,anesthetics',
      },
      {
        label: 'Antenatal record',
        resourceType: 'DocumentReference',
        path: 'antenatal/antenatal-record/patient/{patientId}',
        listPath: 'result',
        patientField: 'patient._id',
        titleField: 'Antenatal record',
        dateField: 'created_at',
        excludeFields: 'anc_followup,partograph,prev_preg_hx,history_of_present_pregnancy',
      },
      {
        label: 'Antenatal visits',
        resourceType: 'Observation',
        path: 'antenatal/antenatal-record/patient/{patientId}',
        listPath: 'result[].anc_followup.vitals',
        patientField: '_parent.patient._id',
        titleField: 'Antenatal visit',
        dateField: 'date',
        detailField: 'BP {bp} · Gestational age {ga} · Lie {lie} · Presentation {presentation_and_position} · Temperature {temperature} · PCV {pcv} · {remarks}',
      },
      {
        label: 'Previous pregnancies',
        resourceType: 'DocumentReference',
        path: 'antenatal/antenatal-record/patient/{patientId}',
        listPath: 'result[].prev_preg_hx',
        patientField: '_parent.patient._id',
        titleField: 'Previous pregnancy',
        dateField: 'date_of_delivery',
        detailField: 'Birth: {birth} · Labour: {labour} · Duration: {duration} · Complication: {complication} · Puerperium: {puerperium} · Sex: {sex}',
      },
      {
        label: 'HIV / ART records',
        resourceType: 'DocumentReference',
        path: 'art/read-records-by-hospital-number?hospital_number={hospitalNumber}',
        listPath: 'result',
        patientField: 'bio.hospital_number',
        patientMatch: 'hospitalNumber',
        titleField: 'HIV / ART record',
        dateField: 'created_at',
        excludeFields: 'bio',
      },
    ],
  },
});

class RecordSourceError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ── Reading values ──────────────────────────────────────────────────────

function at(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const EMPTY_WORDS = /^(none|null|undefined|n\/?a|nil|-+|\.)$/i;
const REFERENCE_ID = /^[0-9a-f]{24}$/i;

function text(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    return !t || EMPTY_WORDS.test(t) ? undefined : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ') || undefined;
  if (typeof v === 'object') return text(v.name ?? v.title ?? v.label ?? v.value ?? v.description ?? v.result ?? v.text) ?? summarise(v, 4);
  return undefined;
}

/** "{a} for {b.c}" template, "a + b" join, or a single path. Empty parts and their separators collapse. */
function readSpec(rec, spec) {
  if (!spec) return undefined;
  const s = String(spec);
  if (s.includes('{')) {
    // Segments between " · " are dropped when none of their fields has a value.
    const cleaned = s
      .split(/\s*·\s*/)
      .map((seg) => {
        let found = false;
        const filled = seg.replace(/\{([\w.$-]+)\}/g, (_, p) => {
          const v = text(at(rec, p));
          if (v) found = true;
          return v ?? '';
        });
        return found || !/\{[\w.$-]+\}/.test(seg) ? filled.replace(/\s{2,}/g, ' ').trim() : '';
      })
      .filter(Boolean)
      .join(' · ');
    return cleaned || undefined;
  }
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const values = parts.map((p) => text(at(rec, p))).filter(Boolean);
  return values.length ? values.join(' ') : undefined;
}

// Field names never shown in the automatic detail line.
const NOISE = /(^|_)(id|ids|uuid|price|amount|billed|billing|paid|payment|insurance|hmo|nhis|auth|code_pay|co_pay|photo|password|token|created|updated|deleted|version|old)(_|$)|^(_id|id|__v|createdAt|updatedAt)$/i;

/** A few short, readable "name: value" pairs from a record, when no detail field is set. */
function summarise(rec, max = 5) {
  if (!rec || typeof rec !== 'object') return undefined;
  const parts = [];
  for (const [k, v] of Object.entries(rec)) {
    if (parts.length >= max) break;
    if (NOISE.test(k) || v == null || typeof v === 'object' || typeof v === 'boolean') continue;
    const t = text(v);
    if (!t || t.length > 120 || REFERENCE_ID.test(t) || /^\d{4}-\d{2}-\d{2}T/.test(t)) continue;
    parts.push(`${k.replace(/_/g, ' ')}: ${t}`);
  }
  return parts.join(' · ') || undefined;
}

function isoDate(v) {
  if (!v) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const TITLE_GUESS = /^(name|title|description|test_?name|drug_?name|diagnosis|condition|investigation|label|type)$/i;
const DATE_GUESS = /^(date|date_?(requested|prescribed|created|recorded|visit_?start)|visit_?date|created_?at|createdAt|start_?date)$/i;

function guessTitle(rec) {
  for (const [k, v] of Object.entries(rec || {})) {
    if (TITLE_GUESS.test(k)) {
      const t = text(v);
      if (t && !REFERENCE_ID.test(t)) return t;
    }
  }
  for (const v of Object.values(rec || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && v.name.trim()) return v.name.trim();
  }
  return undefined;
}

function guessDate(rec) {
  for (const [k, v] of Object.entries(rec || {})) if (DATE_GUESS.test(k) && isoDate(v)) return isoDate(v);
  return undefined;
}

/** The list in an answer: at listPath, the answer itself, or the first array of objects inside it. */
/**
 * "result[].requests": the inner lists of every item, flattened. Each inner
 * record links to its outer one as `_parent` (not enumerable, so it is never
 * shown), e.g. patientField "_parent.patient._id". Plain values (a list of
 * diagnosis words) become { value }.
 */
/** Anything filled in (ignoring IDs, false flags and empty text/lists)? An empty form section is not a record. */
function hasContent(v, depth = 0) {
  if (v == null || v === '' || v === false || depth > 6) return false;
  if (Array.isArray(v)) return v.some((x) => hasContent(x, depth + 1));
  if (typeof v === 'object') return Object.entries(v).some(([k, x]) => !/^(_id|id|__v)$/.test(k) && hasContent(x, depth + 1));
  if (typeof v === 'string') return Boolean(v.trim()) && !EMPTY_WORDS.test(v.trim());
  return true;
}

function nestedList(json, listPath, ancestor = null) {
  const [outerPath, ...rest] = listPath.split('[]');
  const innerPath = rest.join('[]').replace(/^\./, '');
  const outer = outerPath ? at(json, outerPath.replace(/\.$/, '')) : json;
  const out = [];
  for (const raw of Array.isArray(outer) ? outer : outer ? [outer] : []) {
    if (!raw || typeof raw !== 'object') continue;
    // Deeper levels keep a link to the level above ("_parent._parent…"),
    // so the patient can be checked on whichever level names them.
    let parent = raw;
    if (ancestor) {
      parent = { ...raw };
      Object.defineProperty(parent, '_parent', { value: ancestor, enumerable: false });
    }
    if (innerPath.includes('[]')) {
      out.push(...nestedList(parent, innerPath, parent));
      continue;
    }
    const inner = innerPath ? at(parent, innerPath) : parent;
    for (const item of Array.isArray(inner) ? inner : inner != null ? [inner] : []) {
      if (item == null || item === '' || !hasContent(item)) continue;
      const rec = item && typeof item === 'object' ? { ...item } : { value: item };
      Object.defineProperty(rec, '_parent', { value: parent, enumerable: false });
      out.push(rec);
    }
  }
  return out;
}

function listIn(json, listPath) {
  if (listPath && listPath.includes('[]')) return nestedList(json, listPath);
  if (listPath) {
    const v = at(json, listPath);
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
    return v && typeof v === 'object' ? [v] : [];
  }
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object');
  let level = [json];
  for (let depth = 0; depth < 4 && level.length; depth += 1) {
    const next = [];
    for (const v of level) {
      if (!v || typeof v !== 'object') continue;
      for (const child of Object.values(v)) {
        if (Array.isArray(child) && child.some((x) => x && typeof x === 'object')) return child.filter((x) => x && typeof x === 'object');
        if (child && typeof child === 'object' && !Array.isArray(child)) next.push(child);
      }
    }
    level = next;
  }
  return [];
}

// ── Conversion to display resources ─────────────────────────────────────

const LABEL_FIX = { dob: 'Date of birth', id: 'ID', 'd o b': 'Date of birth', 'complaint ii': 'Complaint', 'department route': 'Department' };

function pretty(k) {
  const segs = String(k).split('.').filter((p) => !/^\d+$/.test(p)).slice(-2);
  if (segs.length === 2 && segs[1].toLowerCase().startsWith(segs[0].toLowerCase())) segs.shift();
  const last = segs.join(' ');
  const t = last.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return LABEL_FIX[t] || t.charAt(0).toUpperCase() + t.slice(1);
}

function showValue(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().replace('T', ' ').slice(0, 16);
  }
  return text(v);
}

const PERSON_REF = /(^|_)(by|requester|requested|examiner|staff|doctor|tester|nurse|clinician|physician|prescriber|user|author|creator|reviewer|verifier|approver|collector|receiver|dispenser|professional_?id|consultant|surgeon|attendant|officer|scientist)(_|$)|_by$/i;
/** "requester: 390": a person given only by an internal number. */
function isPersonRef(k, t) {
  return PERSON_REF.test(k) && /^[\w-]{1,40}$/.test(String(t)) && /\d/.test(String(t)) && !/[a-z]{2,}\s+[a-z]{2,}/i.test(String(t));
}

/** Every person-number in a record (2 levels), for looking their names up. */
function personRefsIn(rec, depth = 0, out = new Set()) {
  if (!rec || typeof rec !== 'object' || depth > 2) return out;
  for (const [k, v] of Object.entries(rec)) {
    if ((typeof v === 'number' || typeof v === 'string') && isPersonRef(k, v)) out.add(String(v).trim());
    else if (v && typeof v === 'object' && !Array.isArray(v)) personRefsIn(v, depth + 1, out);
  }
  return out;
}

const NAME_PART = /^(first_?name|last_?name|middle_?name|sur_?name|other_?names?|given_?name|family_?name|complete_?name|full_?name|fname|lname|mname|oname)$/i;

/** A person's full name if this object is a person (has name parts or a full name), else null. */
function personName(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  if (!keys.some((k) => NAME_PART.test(k))) return null;
  const full = text(o.fullname ?? o.full_name ?? o.fullName ?? o.complete_name ?? o.completeName);
  if (full) return full.replace(/\s{2,}/g, ' ');
  const parts = [o.title, o.firstname ?? o.first_name ?? o.firstName ?? o.fname, o.middlename ?? o.middle_name ?? o.middleName ?? o.mname ?? o.oname, o.lastname ?? o.last_name ?? o.lastName ?? o.surname ?? o.lname]
    .map(text)
    .filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// Not useful to a doctor: billing and system codes, account settings, and
// the patient's own demographics (already on the card).
const DETAIL_NOISE = /(^|_)(branch|smart_code|bill|billing|nyr|package|cost|costs|reference|uuid|mobile|online|invoice|hmo|nhis|fhis|exempt|pay_later)(_|$)|^(isNew|disable|show_ranges|payment_status|patient_status|access|roles|availability|permissions|shiftHistory|stores_and_departments|custom_fields|patient_name|patient_sex|patient_dob|patient_type|patientType|d_o_b|dob|sex|gender|hospital_number|old_hospital_number|username|phone|email|address|is_online|online_status|isSuperAdmin|activePackage|__v)$/i;

/** One entry as a short line: "Condition: Asthma; Year: 2019; Treated: yes". */
function compact(obj, people = null, depth = 0, hideDiagnoses = false) {
  if (!obj || typeof obj !== 'object' || depth > 2) return '';
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (/^(_id|id|__v)$/.test(k) || NOISE.test(k) || DETAIL_NOISE.test(k) || v == null || v === '' || v === false) continue;
    if (hideDiagnoses && DIAGNOSIS_KEY.test(k)) continue;
    if (Array.isArray(v)) {
      const inner = v.map((x) => (x && typeof x === 'object' ? compact(x, people, depth + 1, hideDiagnoses) : x != null && isIdLike(x) ? people && people.get(x) : text(x))).filter(Boolean).join(', ');
      if (inner) parts.push(`${pretty(k)}: ${inner}`);
    } else if (typeof v === 'object') {
      const n = personName(v);
      const inner = n || compact(v, people, depth + 1, hideDiagnoses);
      if (inner) parts.push(`${pretty(k)}: ${inner}`);
    } else if (isPersonRef(k, v)) {
      const n = people && people.get(String(v));
      if (n) parts.push(`${pretty(k)}: ${n}`);
    } else {
      const t = v === true ? 'yes' : showValue(v);
      if (t && isIdLike(t)) {
        const n = people && people.get(t);
        if (n) parts.push(`${pretty(k)}: ${n}`);
      } else if (t) parts.push(`${pretty(k)}: ${t}`);
    }
  }
  return parts.join('; ');
}

/** Every readable field of a record (2 levels), noise left out: [{ label, value }]. */
const DIAGNOSIS_KEY = /diagnos|icd_?code|impression/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A system ID (database ID, UUID, or IDs joined by _/-): never shown as such. */
function isIdLike(t) {
  const x = String(t).trim();
  return REFERENCE_ID.test(x) || UUID.test(x) || /^[0-9a-f]{24}([_-][0-9a-f]{24})+$/i.test(x);
}

const NAME_FIELDS = ['service_name', 'item_name', 'drug_name', 'test_name', 'name', 'title', 'desc', 'label'];

/**
 * Every "ID -> name" pair found in the given objects (and their linked
 * records): e.g. a lab test definition's sub-tests, a drug list, staff.
 * Used so an ID is shown by its name, or not at all.
 */
function nameIndex(...roots) {
  const idx = new Map();
  const seen = new Set();
  const walk = (v, d) => {
    if (!v || typeof v !== 'object' || d > 8 || seen.has(v) || seen.size > 20000) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, d + 1));
      return;
    }
    const id = v._id ?? v.id;
    if (id != null && (typeof id === 'string' || typeof id === 'number') && !idx.has(String(id))) {
      const n = personName(v) || NAME_FIELDS.map((f) => (typeof v[f] === 'string' ? text(v[f]) : undefined)).find((x) => x && !isIdLike(x));
      if (n) idx.set(String(id), n);
    }
    for (const x of Object.values(v)) walk(x, d + 1);
    for (const k of ['_parent', '_join']) if (v[k]) walk(v[k], d + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return idx;
}

/** Names for IDs: from the record's own context first, then staff lookups. */
function resolver(idx, people) {
  return { get: (id) => (id == null ? null : idx.get(String(id).trim()) || (people && people.get(id)) || null) };
}

function allDetails(rec, prefix = '', depth = 0, out = [], people = null, exclude = null, hideDiagnoses = false) {
  if (!rec || typeof rec !== 'object' || depth > 2 || out.length >= 60) return out;
  const ownName = personName(rec);
  // A record's own top-level name is normally the patient's (already on the card); people inside it are shown.
  if (ownName && depth > 0) out.push({ label: pretty(prefix), value: ownName });
  // Flat name parts with a prefix ("admitted_by_fname", "admitted_by_lname"): one line.
  const PREFIXED = /^(.+?)_(fname|lname|oname|mname|firstname|lastname|middlename|first_name|last_name|middle_name|surname)$/i;
  const prefixes = new Set(Object.keys(rec).map((k) => (PREFIXED.exec(k) || [])[1]).filter(Boolean));
  for (const px of prefixes) {
    const n = [rec[`${px}_title`], rec[`${px}_fname`] ?? rec[`${px}_firstname`] ?? rec[`${px}_first_name`], rec[`${px}_mname`] ?? rec[`${px}_oname`] ?? rec[`${px}_middlename`] ?? rec[`${px}_middle_name`], rec[`${px}_lname`] ?? rec[`${px}_lastname`] ?? rec[`${px}_last_name`] ?? rec[`${px}_surname`]].map(text).filter(Boolean).join(' ');
    if (n) out.push({ label: pretty(px), value: n });
  }
  for (const [k, v] of Object.entries(rec)) {
    if (out.length >= 60) break;
    const key = prefix ? `${prefix}.${k}` : k;
    if (NOISE.test(k) || DETAIL_NOISE.test(k) || /^(patient|photo|insurance|insurances|password)$/i.test(k)) continue;
    if (v === false) continue; // "Is archived: false" says nothing
    if (exclude && depth === 0 && exclude.has(k)) continue;
    // Diagnoses are shown only under Diagnoses (Condition), so a patient who
    // doesn't share diagnoses never has one shown inside another record.
    if (hideDiagnoses && DIAGNOSIS_KEY.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // A person (staff, examiner, requester…): one line with their full name.
      const person = personName(v);
      if (person) {
        out.push({ label: pretty(k), value: person });
        continue;
      }
      allDetails(v, key, depth + 1, out, people, null, hideDiagnoses);
      continue;
    }
    // Name parts are shown once, as the full name above.
    if (NAME_PART.test(k) && ownName) continue;
    if (PREFIXED.test(k) || [...prefixes].some((px) => k.startsWith(`${px}_`) && /_(gender|sex|title|department_route|phone|email)$/i.test(k))) continue;
    if (Array.isArray(v)) {
      if (v.every((x) => x == null || typeof x !== 'object')) {
        // IDs in a list are shown by name; IDs without a name are left out.
        const t = v.map((x) => (x != null && isIdLike(x) ? people && people.get(x) : text(x))).filter(Boolean).join(', ');
        if (t) out.push({ label: pretty(key), value: t });
      } else {
        // A list of entries (e.g. previous conditions, surgeries): one line each.
        const items = v.filter((x) => x && typeof x === 'object' && hasContent(x)).slice(0, 50);
        items.forEach((x, i) => {
          const line = personName(x) || compact(x, people, 0, hideDiagnoses);
          if (line) out.push({ label: items.length > 1 ? `${pretty(key)} ${i + 1}` : pretty(key), value: line });
        });
      }
      continue;
    }
    const t = showValue(v);
    if (!t || t.length > 2000) continue;
    if (isIdLike(t)) {
      const n = people && people.get(t);
      if (n) out.push({ label: pretty(key), value: n });
      continue;
    }
    // A person given only as an internal number ("requester: 390") is an
    // ID, not a name: never shown (their name shows where the hospital sends it).
    if (isPersonRef(k, t)) {
      const n = people && people.get(t);
      if (n) out.push({ label: pretty(key), value: n });
      continue;
    }
    out.push({ label: pretty(key), value: t });
  }
  return out;
}

const NAME_KEYS = ['parameter.name', 'parameter', 'service_name', 'name', 'test.name', 'test_name', 'label', 'title', 'component', 'analyte', 'field'];
const VALUE_KEYS = ['value', 'result', 'result_value', 'reading', 'finding', 'findings', 'observation', 'answer'];
const UNIT_KEYS = ['unit', 'units', 'unit.name', 'parameter.unit', 'si_unit', 'uom'];
const RANGE_KEYS = ['range', 'reference_range', 'normal_range', 'ref_range', 'reference', 'parameter.range', 'parameter.reference_range'];
const FLAG_KEYS = ['flag', 'abnormal_flag', 'interpretation', 'remark', 'comment'];

function firstOf(rec, keys) {
  for (const k of keys) {
    const v = text(at(rec, k));
    if (v) return v;
  }
  return undefined;
}

/**
 * A result answer as rows (one per measured value) and other details.
 * Lists of objects with a name and a value become rows; everything else
 * readable becomes details.
 */
/** Normal range for the patient's sex (SmartClinic: female_low_range/female_high_range…), else every range given. */
function sexRange(item, sex) {
  const pick = (p) => {
    const lo = text(item[`${p}_low_range`]);
    const hi = text(item[`${p}_high_range`]);
    return lo || hi ? `${lo ?? ''}–${hi ?? ''}` : undefined;
  };
  const s = String(sex || '').toLowerCase();
  const own = /^f/.test(s) ? pick('female') : /^m/.test(s) ? pick('male') : undefined;
  if (own) return own;
  const all = [['female', 'F'], ['male', 'M'], ['child', 'Child'], ['infant', 'Infant']].map(([p, l]) => (pick(p) ? `${l} ${pick(p)}` : null)).filter(Boolean);
  return all.length ? all.join('; ') : undefined;
}

function resultParts(json, people = null) {
  const rows = [];
  const seen = new Set();
  const used = new Set(); // list items that became rows (not repeated in details)
  const sex = json && typeof json === 'object' ? text(json.sex ?? (json.patient && json.patient.sex) ?? json.gender) : undefined;
  // One result object with its own name and value (e.g. SmartClinic: title, value, unit).
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const name = firstOf(json, NAME_KEYS);
    const value = firstOf(json, VALUE_KEYS);
    if (name && value && typeof json.value !== 'object') {
      seen.add(`${name}|${value}`);
      rows.push({ name, value, unit: firstOf(json, UNIT_KEYS), range: firstOf(json, RANGE_KEYS), flag: firstOf(json, FLAG_KEYS) });
    }
  }
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || rows.length >= 200) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== 'object') continue;
        const name = firstOf(item, NAME_KEYS);
        const value = firstOf(item, VALUE_KEYS);
        if (name && value && typeof at(item, 'value') !== 'object') {
          const key = `${name}|${value}`;
          if (!seen.has(key)) {
            seen.add(key);
            const min = text(item.min ?? item.minimum ?? item.lower_limit ?? (item.parameter && item.parameter.min));
            const max = text(item.max ?? item.maximum ?? item.upper_limit ?? (item.parameter && item.parameter.max));
            used.add(item);
            rows.push({
              name,
              value,
              unit: firstOf(item, UNIT_KEYS),
              range: firstOf(item, RANGE_KEYS) || (min || max ? `${min ?? ''}–${max ?? ''}` : sexRange(item, sex)),
              flag: firstOf(item, FLAG_KEYS),
            });
          }
        } else {
          walk(item, depth + 1);
        }
      }
      return;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(json, 0);
  const body = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
  const top = Array.isArray(body) ? body[0] : body;
  const rowLists = new Set(top && typeof top === 'object' ? Object.entries(top).filter(([, v]) => Array.isArray(v) && v.some((x) => used.has(x))).map(([k]) => k) : []);
  const details = allDetails(top, '', 0, [], people, rowLists.size ? rowLists : null).filter((d) => !/^(status|message)$/i.test(d.label));
  return { rows, details };
}

/** Patient IDs found anywhere near the top of an answer (to refuse someone else's result). */
function patientIdsIn(json, patientField) {
  const ids = new Set();
  const look = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 3) return;
    if (Array.isArray(node)) return node.slice(0, 20).forEach((x) => look(x, depth + 1));
    for (const f of [patientField, 'patient_id', 'patientId', 'patient.id', 'patient._id']) {
      const v = f && at(node, f);
      if (v != null && typeof v !== 'object' && String(v).trim() !== '') ids.add(String(v).trim());
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') look(v, depth + 1);
  };
  look(json, 0);
  return ids;
}

/** The full result for one record (resultPath), or null if it has none / it isn't this patient's. */
async function readResult(src, rec, getJson, patientId, people = null, cache = null) {
  for (const alt of String(src.resultPath).split('|').map((x) => x.trim()).filter(Boolean)) {
    let missing = false;
    const path = alt.replace(/\{([\w.$-]+)\}/g, (_, f) => {
      const v = at(rec, f);
      if (v == null || v === '' || typeof v === 'object') missing = true;
      return encodeURIComponent(String(v ?? ''));
    });
    if (missing) continue;
    let json;
    try {
      if (cache) {
        if (!cache.has(path)) cache.set(path, getJson(path, {}));
        json = await cache.get(path);
      } else {
        json = await getJson(path, {});
      }
    } catch {
      continue;
    }
    // Several results in one answer (e.g. all of an appointment's): keep
    // the one belonging to this record ("test=test._id").
    if (src.resultMatch) {
      const [resKey, recKey] = src.resultMatch.split('=');
      const want = at(rec, recKey);
      if (want == null || want === '') continue;
      const hit = listIn(json, '').filter((it) => String(at(it, resKey) ?? '') === String(want));
      if (!hit.length) continue;
      json = hit[0];
    }
    // Shown only if the answer itself names THIS patient: a result whose
    // patient can't be confirmed, or another patient's, is never shown.
    const ids = patientIdsIn(json, src.patientField);
    if (!ids.has(String(patientId).trim()) || ids.size > 1) continue;
    if (people) {
      const b = json && json.data && typeof json.data === 'object' ? json.data : json;
      await people.resolve(Array.isArray(b) ? b.slice(0, 1) : [b]);
    }
    const parts = resultParts(json, resolver(nameIndex(json, rec), people));
    if (parts.rows.length || parts.details.length) return parts;
  }
  return null;
}

function toResource(src, rec, index, people = null) {
  const rawId = text(at(rec, src.idField || 'id')) ?? text(rec._id) ?? String(index);
  // A plain title with spaces and no field in braces ("Past medical history") is shown as written.
  const literal = src.titleField && !src.titleField.includes('{') && /\s/.test(src.titleField) && at(rec, src.titleField) === undefined ? src.titleField : '';
  const title = literal || readSpec(rec, src.titleField) || guessTitle(rec) || src.label || src.resourceType;
  const date = isoDate(readSpec(rec, src.dateField)) || guessDate(rec);
  const detail = src.detailField ? readSpec(rec, src.detailField) : summarise(rec);
  const status = src.statusField ? readSpec(rec, src.statusField) : undefined;
  const who = src.whoField ? readSpec(rec, src.whoField) : undefined;
  const r = { resourceType: src.resourceType, id: `${slug(src.label || src.resourceType)}-${rawId}`, meta: { source: 'live-emr', tag: [{ display: src.label }] } };
  // Display-only extras (not FHIR): every readable field, for "Show all details".
  // "Leave out" fields: e.g. diagnoses inside consultation notes are shown
  // only through the Diagnoses source, so a grant without diagnoses never
  // shows them.
  const exclude = src.excludeFields ? new Set(src.excludeFields.split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const names = resolver(nameIndex(rec), people);
  r.details = allDetails(rec, '', 0, [], names, exclude, src.resourceType !== 'Condition');
  // A result held inside the record itself (e.g. SmartClinic lab requests).
  const inline = rec.result && typeof rec.result === 'object' ? rec.result : rec.report && typeof rec.report === 'object' ? rec.report : null;
  if (!src.resultPath && inline) {
    const parts = resultParts(inline, names);
    if (parts.rows.length || parts.details.length) {
      r.result = parts;
      const spec = parts.details.find((d) => /^specimen type$/i.test(d.label));
      if (spec) r.specimen = [{ display: spec.value }];
      if (parts.rows.length && src.resourceType === 'Observation') r.valueString = parts.rows.map((x) => `${x.name}: ${x.value}${x.unit ? ` ${x.unit}` : ''}`).join(' · ');
    }
  }
  if (status) r.status = status;
  const note = detail ? [{ text: detail }] : undefined;
  switch (src.resourceType) {
    case 'Encounter':
      r.reasonCode = [{ text: title }];
      if (date) r.period = { start: date };
      if (who) r.participant = [{ individual: { display: who } }];
      if (note) r.note = note;
      break;
    case 'Observation':
      r.code = { text: title };
      if (date) r.effectiveDateTime = date;
      if (detail) r.valueString = detail;
      if (who) r.performer = [{ display: who }];
      break;
    case 'DiagnosticReport':
      r.code = { text: title };
      if (date) r.effectiveDateTime = date;
      if (detail) r.conclusion = detail;
      if (who) r.performer = [{ display: who }];
      break;
    case 'MedicationRequest':
      r.medicationCodeableConcept = { text: title };
      if (date) r.authoredOn = date;
      if (detail) r.dosageInstruction = [{ text: detail }];
      if (who) r.requester = { display: who };
      break;
    case 'AllergyIntolerance':
      r.code = { text: title };
      if (date) r.recordedDate = date;
      if (detail) r.reaction = [{ manifestation: [{ text: detail }] }];
      break;
    case 'DocumentReference':
      r.description = title;
      if (date) r.date = date;
      if (detail) r.content = [{ attachment: { contentType: 'text/plain', data: Buffer.from(detail, 'utf8').toString('base64') } }];
      break;
    default: // Condition
      r.code = { text: title };
      if (date) r.recordedDate = date;
      if (who) r.recorder = { display: who };
      if (note) r.note = note;
  }
  return r;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'record';
}

// ── Validation (hospital registry) ──────────────────────────────────────

/** Cleans and checks the record sources from the setup wizard. */
function cleanRecordSources(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new RecordSourceError('record sources must be a list');
  if (input.length > MAX_SOURCES) throw new RecordSourceError(`at most ${MAX_SOURCES} record sources`);
  const out = input.map((raw, i) => {
    const s = {};
    for (const k of SOURCE_FIELDS) s[k] = String((raw && raw[k]) ?? '').trim().slice(0, k === 'excludeFields' ? 3000 : 600);
    const name = s.label || `record source ${i + 1}`;
    if (!s.label) s.label = name;
    if (!RESOURCE_TYPES.includes(s.resourceType)) throw new RecordSourceError(`${name}: choose what kind of record it is`);
    if (!s.path) throw new RecordSourceError(`${name}: enter the API path`);
    if (!/\{(patientId|hospitalNumber|visitId)\}/.test(s.path)) throw new RecordSourceError(`${name}: the path must contain {patientId}, {hospitalNumber} or {visitId}`);
    if (/^[a-z]+:\/\//i.test(s.path) || s.path.includes('..')) throw new RecordSourceError(`${name}: the path must be relative to the API address`);
    if (!s.patientField) throw new RecordSourceError(`${name}: enter the field that holds the patient ID (e.g. patient_id), so other patients' records are never shown`);
    if (s.resultPath) {
      for (const alt of s.resultPath.split('|').map((x) => x.trim()).filter(Boolean)) {
        if (/^[a-z]+:\/\//i.test(alt) || alt.includes('..') || !/\{[\w.$-]+\}/.test(alt) || !/^[\w\-/.{}$?=&]+$/.test(alt)) {
          throw new RecordSourceError(`${name}: the result address must be relative and contain a field in braces, e.g. results/get/{result_id}`);
        }
      }
    }
    for (const k of ['listPath', 'patientField', 'idField']) {
      if (s[k] && !/^[\w.$\[\]-]+$/.test(s[k])) throw new RecordSourceError(`${name}: invalid field "${s[k]}"`);
    }
    if (s.excludeFields && !/^[\w.$,\s-]+$/.test(s.excludeFields)) throw new RecordSourceError(`${name}: invalid list of fields to leave out`);
    if (s.patientMatch && !['id', 'hospitalNumber'].includes(s.patientMatch)) throw new RecordSourceError(`${name}: patient match must be id or hospitalNumber`);
    for (const k of ['joinField', 'joinList']) if (s[k] && !/^[\w.$-]+$/.test(s[k])) throw new RecordSourceError(`${name}: invalid ${k} "${s[k]}"`);
    if (Boolean(s.joinField) !== Boolean(s.joinList)) throw new RecordSourceError(`${name}: a name lookup needs both the record field and the list to look in`);
    if (s.resultMatch && !/^[\w.$-]+=[\w.$-]+$/.test(s.resultMatch)) throw new RecordSourceError(`${name}: result match must look like resultField=recordField, e.g. test=test._id`);
    for (const k of ['titleField', 'dateField', 'detailField', 'statusField', 'whoField']) {
      if (s[k] && !FIELD_SPEC.test(s[k])) throw new RecordSourceError(`${name}: invalid field "${s[k]}"`);
    }
    return s;
  });
  if (out.some((s) => s.path.includes('{visitId}')) && !out.some((s) => s.resourceType === 'Encounter' && !s.path.includes('{visitId}'))) {
    throw new RecordSourceError('per-visit sources ({visitId}) need a Visits source (kind: Encounter) to list the visits');
  }
  return out;
}

// ── Reading ─────────────────────────────────────────────────────────────

/**
 * Reads every source for one patient. `getJson(path, vars)` calls the
 * hospital's API (signed in); `patientId` is the EMR's own patient ID.
 * `types` limits which sources are read (the grant's scope); the visits
 * source is always read when per-visit sources need it.
 * Returns { resources, sources: [{ label, ok, count, dropped, error }] }.
 */
const MAX_PEOPLE_LOOKUPS = 40;

/**
 * Looks staff numbers up by name (staffPath, e.g. "staffs/{id}") with a
 * cache; only the person's name is taken from the answer.
 */
function peopleLookup(getJson, staffPath) {
  const names = new Map();
  let lookups = 0;
  return {
    names,
    async resolve(records) {
      if (!staffPath) return;
      const ids = new Set();
      for (const r of records) personRefsIn(r, 0, ids);
      for (const id of ids) {
        if (names.has(id) || lookups >= MAX_PEOPLE_LOOKUPS) continue;
        lookups += 1;
        let n = null;
        try {
          const json = await getJson(staffPath.replace(/\{(id|staffId|staffID)\}/g, encodeURIComponent(id)), {});
          const body = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
          n = personName(Array.isArray(body) ? body[0] : body) || text(body && (body.name || body.displayName));
        } catch {
          n = null;
        }
        names.set(id, n || null);
      }
    },
    get: (id) => names.get(String(id).trim()) || null,
  };
}

async function readRecords({ sources, getJson, patientId, hospitalNumber, types, maxVisits = MAX_VISITS, staffPath = '' }) {
  const people = peopleLookup(getJson, staffPath);
  const wanted = (s) => !types || !types.length || types.includes(s.resourceType);
  const report = [];
  const resources = [];
  // patientMatch "hospitalNumber": the record names the patient by hospital
  // number instead of the system's own patient ID (e.g. SmartClinic ART).
  const own = (rec, src) => {
    const v = at(rec, src.patientField);
    const want = src.patientMatch === 'hospitalNumber' ? hospitalNumber : patientId;
    return v != null && want != null && String(v).trim() !== '' && String(v).trim().toLowerCase() === String(want).trim().toLowerCase();
  };
  // Name lookup within the same answer: e.g. a prescription's drug ID ->
  // the drug's details listed elsewhere in the answer. Linked as _join
  // (not enumerable, so the details list doesn't repeat the whole entry).
  const joinIn = (json, src, list) => {
    if (!src.joinField) return;
    const table = new Map(listIn(json, src.joinList).map((x) => [String(x._id ?? x.id), x]));
    for (const r of list) {
      const hit = table.get(String(at(r, src.joinField)));
      if (hit) Object.defineProperty(r, '_join', { value: hit, enumerable: false });
    }
  };
  // "Not found" from the hospital means "no records of this kind".
  const notFound = (err) => /HTTP 404\b/.test(String(err && err.message));
  const answers = new Map(); // one request per address, shared by sources
  const fetchList = async (src, vars) => {
    if (!answers.has(src.path)) answers.set(src.path, getJson(src.path, vars));
    let json;
    try {
      json = await answers.get(src.path);
    } catch (err) {
      if (notFound(err)) return { mine: [], dropped: 0 };
      throw err;
    }
    const list = listIn(json, src.listPath).slice(0, MAX_RECORDS_PER_SOURCE);
    const mine = list.filter((r) => own(r, src));
    joinIn(json, src, mine);
    return { mine, dropped: list.length - mine.length };
  };

  let resultReads = 0;
  const resultCache = new Map(); // one request per result address (e.g. per appointment)
  const withResult = async (src, rec, resource) => {
    if (!src.resultPath || resultReads >= MAX_RESULT_READS) return resource;
    resultReads += 1;
    const result = await readResult(src, rec, getJson, patientId, people, resultCache);
    if (result) {
      resource.result = result; // display-only: rows (name/value/unit/range/flag) and details
      const spec = result.details.find((d) => /^specimen type$/i.test(d.label)) || result.details.find((d) => /specimen/i.test(d.label) && !/by|date/i.test(d.label));
      if (spec) resource.specimen = [{ display: spec.value }];
      if (result.rows.length && src.resourceType === 'Observation') {
        resource.valueString = result.rows.map((x) => `${x.name}: ${x.value}${x.unit ? ` ${x.unit}` : ''}`).join(' · ');
      }
      if (src.resourceType === 'DiagnosticReport' && !resource.conclusion) {
        const c = result.details.find((d) => /(conclusion|impression|finding|report|result)/i.test(d.label));
        if (c) resource.conclusion = c.value;
      }
    }
    return resource;
  };
  const base = { patientId, hospitalNumber };
  // Ask for every address needed at once (each only once): hospital
  // systems can be slow, and one at a time adds up.
  for (const src of sources) {
    if (src.path.includes('{visitId}') || !(wanted(src) || src.resourceType === 'Encounter')) continue;
    if (!answers.has(src.path)) {
      const pr = getJson(src.path, base);
      pr.catch(() => {});
      answers.set(src.path, pr);
    }
  }
  const prefetchResults = async (src, mine) => {
    if (!src.resultPath) return;
    const paths = new Set();
    for (const rec of mine) {
      const alt = String(src.resultPath).split('|')[0].trim();
      let missing = false;
      const path = alt.replace(/\{([\w.$-]+)\}/g, (_, f) => {
        const v = at(rec, f);
        if (v == null || v === '' || typeof v === 'object') missing = true;
        return encodeURIComponent(String(v ?? ''));
      });
      if (!missing && !resultCache.has(path)) paths.add(path);
    }
    const list = [...paths].slice(0, MAX_RESULT_READS);
    for (let i = 0; i < list.length; i += 6) {
      await Promise.all(list.slice(i, i + 6).map((path) => {
        const pr = getJson(path, {});
        pr.catch(() => {});
        resultCache.set(path, pr);
        return pr.catch(() => null);
      }));
    }
  };
  const visitSource = sources.find((s) => s.resourceType === 'Encounter' && !s.path.includes('{visitId}'));
  const perVisit = sources.filter((s) => s.path.includes('{visitId}') && wanted(s));
  let visits = [];

  for (const src of sources.filter((s) => !s.path.includes('{visitId}'))) {
    const needed = wanted(src) || (src === visitSource && perVisit.length);
    if (!needed) continue;
    try {
      const { mine, dropped } = await fetchList(src, base);
      if (src === visitSource) {
        visits = mine
          .map((r) => ({ id: text(at(r, src.idField || 'id')) ?? text(r._id), date: isoDate(readSpec(r, src.dateField)) || guessDate(r) || '' }))
          .filter((v) => v.id)
          .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
          .slice(0, maxVisits);
      }
      if (wanted(src)) {
        await prefetchResults(src, mine);
        await people.resolve(mine);
        for (const [i, r] of mine.entries()) resources.push(await withResult(src, r, toResource(src, r, i, people)));
      }
      report.push({ label: src.label, ok: true, count: wanted(src) ? mine.length : 0, dropped });
    } catch (err) {
      report.push({ label: src.label, ok: false, count: 0, error: err.message });
    }
  }

  // Per-visit sources: several may share one path (e.g. tests and drugs in
  // one answer), so each path is read once per visit.
  const cache = new Map();
  for (const src of perVisit) {
    let count = 0;
    let dropped = 0;
    const errors = [];
    for (const v of visits) {
      const key = `${src.path}|${v.id}`;
      try {
        if (!cache.has(key)) cache.set(key, getJson(src.path, { ...base, visitId: v.id }));
        const json = await cache.get(key);
        const list = listIn(json, src.listPath).slice(0, MAX_RECORDS_PER_SOURCE);
        const mine = list.filter((r) => own(r, src));
        joinIn(json, src, mine);
        dropped += list.length - mine.length;
        await people.resolve(mine);
        for (const [i, r] of mine.entries()) resources.push(await withResult(src, r, toResource(src, r, `${v.id}-${i}`, people)));
        count += mine.length;
      } catch (err) {
        if (!notFound(err)) errors.push(err.message);
      }
    }
    report.push({ label: src.label, ok: errors.length === 0, count, dropped, ...(errors.length ? { error: `${errors.length} of ${visits.length} visit(s) failed: ${errors[0]}` } : {}) });
  }
  return { resources, sources: report };
}

module.exports = {
  personRefsIn,
  personName,
  readRecords,
  resultParts,
  allDetails,
  cleanRecordSources,
  toResource,
  readSpec,
  listIn,
  RESOURCE_TYPES,
  RECORD_PRESETS,
  RecordSourceError,
};
