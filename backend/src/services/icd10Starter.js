'use strict';

/**
 * icd10Starter.js
 *
 * Starter diagnosis catalogue: common diagnoses in Nigerian hospitals with
 * their WHO ICD-10 codes, plus the local names clinicians actually type
 * ("MP+", "RVD", "CSM"). Nigeria has no mandated diagnosis code system;
 * ICD-10 is what the Federal Ministry of Health's health records system
 * uses where coding is done, and ICD-11 is being introduced. Codes here
 * follow ICD-10 (WHO, 2019 edition).
 *
 * Clinicians can add a term that is not listed; it gets a provisional
 * LOCAL-nnnn code until a health records officer maps it to ICD-10 from
 * the Insights page. The catalogue grows; this list only seeds it.
 */

const ICD10_STARTER = [
  // Infectious and parasitic
  ['B54', 'Unspecified malaria', ['malaria', 'mp+', 'mp positive', 'malaria fever', 'plasmodiasis', 'uncomplicated malaria']],
  ['B50.9', 'Plasmodium falciparum malaria, unspecified', ['falciparum malaria', 'p. falciparum']],
  ['B50.0', 'Plasmodium falciparum malaria with cerebral complications', ['cerebral malaria', 'severe malaria']],
  ['A01.0', 'Typhoid fever', ['typhoid', 'enteric fever', 'widal positive']],
  ['A09', 'Diarrhoea and gastroenteritis of presumed infectious origin', ['gastroenteritis', 'diarrhoea', 'diarrhea', 'ge', 'acute gastroenteritis']],
  ['A00.9', 'Cholera, unspecified', ['cholera']],
  ['A15.0', 'Tuberculosis of lung, confirmed by sputum microscopy', ['tb', 'ptb', 'pulmonary tuberculosis', 'tuberculosis']],
  ['B24', 'Unspecified human immunodeficiency virus [HIV] disease', ['hiv', 'rvd', 'retroviral disease', 'aids', 'pldhiv']],
  ['A96.2', 'Lassa fever', ['lassa']],
  ['A39.0', 'Meningococcal meningitis', ['csm', 'cerebrospinal meningitis', 'meningococcal']],
  ['G03.9', 'Meningitis, unspecified', ['meningitis']],
  ['B05.9', 'Measles without complication', ['measles']],
  ['A35', 'Other tetanus', ['tetanus']],
  ['A33', 'Tetanus neonatorum', ['neonatal tetanus']],
  ['B18.1', 'Chronic viral hepatitis B without delta-agent', ['hepatitis b', 'hbv', 'hbsag positive', 'hep b']],
  ['B17.1', 'Acute hepatitis C', ['hepatitis c', 'hcv', 'hep c']],
  ['B65.9', 'Schistosomiasis, unspecified', ['schistosomiasis', 'bilharzia']],
  ['B82.9', 'Intestinal parasitism, unspecified', ['worm infestation', 'helminthiasis', 'worms']],
  ['A82.9', 'Rabies, unspecified', ['rabies']],
  ['U07.1', 'COVID-19, virus identified', ['covid', 'covid-19', 'coronavirus']],
  ['A41.9', 'Sepsis, unspecified', ['sepsis', 'septicaemia', 'septicemia']],
  // Respiratory
  ['J18.9', 'Pneumonia, unspecified', ['pneumonia', 'chest infection', 'lrti']],
  ['J06.9', 'Acute upper respiratory infection, unspecified', ['urti', 'catarrh', 'common cold', 'upper respiratory tract infection']],
  ['J45.9', 'Asthma, unspecified', ['asthma', 'bronchial asthma']],
  ['J44.9', 'Chronic obstructive pulmonary disease, unspecified', ['copd']],
  // Cardiovascular and metabolic
  ['I10', 'Essential (primary) hypertension', ['hypertension', 'htn', 'high blood pressure', 'hbp', 'essential hypertension']],
  ['I50.9', 'Heart failure, unspecified', ['heart failure', 'ccf', 'congestive cardiac failure']],
  ['I64', 'Stroke, not specified as haemorrhage or infarction', ['stroke', 'cva', 'cerebrovascular accident']],
  ['I47.1', 'Supraventricular tachycardia', ['svt', 'supraventricular tachycardia', 'paroxysmal supraventricular tachycardia']],
  ['E11.9', 'Type 2 diabetes mellitus without complications', ['diabetes', 'dm', 'type 2 diabetes', 't2dm', 'sugar']],
  ['E10.9', 'Type 1 diabetes mellitus without complications', ['type 1 diabetes', 't1dm']],
  ['E66.9', 'Obesity, unspecified', ['obesity']],
  // Nutrition and blood
  ['E43', 'Unspecified severe protein-energy malnutrition', ['severe acute malnutrition', 'sam', 'marasmus']],
  ['E40', 'Kwashiorkor', ['kwashiorkor']],
  ['D57.0', 'Sickle-cell anaemia with crisis', ['sickle cell crisis', 'vaso-occlusive crisis', 'voc', 'scd crisis']],
  ['D57.1', 'Sickle-cell anaemia without crisis', ['sickle cell', 'sickle cell disease', 'scd', 'hbss']],
  ['D64.9', 'Anaemia, unspecified', ['anaemia', 'anemia']],
  ['D50.9', 'Iron deficiency anaemia, unspecified', ['iron deficiency anaemia', 'ida']],
  // Digestive and renal
  ['K29.7', 'Gastritis, unspecified', ['gastritis', 'ulcer', 'dyspepsia']],
  ['K35.8', 'Acute appendicitis, other and unspecified', ['appendicitis']],
  ['K74.6', 'Other and unspecified cirrhosis of liver', ['liver cirrhosis', 'cirrhosis']],
  ['N39.0', 'Urinary tract infection, site not specified', ['uti', 'urinary tract infection']],
  ['N18.9', 'Chronic kidney disease, unspecified', ['ckd', 'chronic kidney disease', 'chronic renal failure']],
  ['N17.9', 'Acute renal failure, unspecified', ['aki', 'acute kidney injury', 'acute renal failure']],
  ['N40', 'Hyperplasia of prostate', ['bph', 'enlarged prostate']],
  // Pregnancy, childbirth and newborn
  ['Z34.9', 'Supervision of normal pregnancy, unspecified', ['antenatal care', 'anc', 'normal pregnancy']],
  ['O14.1', 'Severe pre-eclampsia', ['severe pre-eclampsia', 'severe preeclampsia']],
  ['O14.9', 'Pre-eclampsia, unspecified', ['pre-eclampsia', 'preeclampsia', 'pih']],
  ['O15.9', 'Eclampsia, unspecified as to time period', ['eclampsia']],
  ['O72.1', 'Other immediate postpartum haemorrhage', ['pph', 'postpartum haemorrhage', 'postpartum hemorrhage']],
  ['O80', 'Single spontaneous delivery', ['svd', 'spontaneous vaginal delivery', 'normal delivery']],
  ['O82', 'Single delivery by caesarean section', ['caesarean section', 'c-section', 'cs']],
  ['O03.9', 'Spontaneous abortion, complete or unspecified, without complication', ['miscarriage', 'spontaneous abortion']],
  ['F53.0', 'Mild mental and behavioural disorders associated with the puerperium', ['postpartum depression', 'postnatal depression']],
  ['P36.9', 'Bacterial sepsis of newborn, unspecified', ['neonatal sepsis']],
  ['P59.9', 'Neonatal jaundice, unspecified', ['neonatal jaundice', 'nnj']],
  ['P21.9', 'Birth asphyxia, unspecified', ['birth asphyxia', 'perinatal asphyxia']],
  ['P07.3', 'Other preterm infants', ['preterm', 'prematurity']],
  // Mental health and neurology
  ['F32.9', 'Depressive episode, unspecified', ['depression']],
  ['F20.9', 'Schizophrenia, unspecified', ['schizophrenia']],
  ['G40.9', 'Epilepsy, unspecified', ['epilepsy', 'seizure disorder']],
  // Injury and poisoning
  ['S06.9', 'Intracranial injury, unspecified', ['head injury', 'tbi']],
  ['T14.9', 'Injury, unspecified', ['injury', 'rta injury', 'trauma']],
  ['T30.0', 'Burn of unspecified body region, unspecified degree', ['burns', 'burn']],
  ['T63.0', 'Toxic effect of snake venom', ['snakebite', 'snake bite']],
  // Eye, ear, skin, musculoskeletal
  ['H10.9', 'Conjunctivitis, unspecified', ['conjunctivitis', 'apollo']],
  ['H66.9', 'Otitis media, unspecified', ['otitis media', 'ear infection']],
  ['H26.9', 'Cataract, unspecified', ['cataract']],
  ['L08.9', 'Local infection of skin and subcutaneous tissue, unspecified', ['skin infection', 'cellulitis', 'abscess']],
  ['M54.5', 'Low back pain', ['low back pain', 'lbp', 'back pain']],
  // Neoplasms
  ['C50.9', 'Malignant neoplasm of breast, unspecified', ['breast cancer', 'ca breast']],
  ['C53.9', 'Malignant neoplasm of cervix uteri, unspecified', ['cervical cancer', 'ca cervix']],
  ['C61', 'Malignant neoplasm of prostate', ['prostate cancer', 'ca prostate']],
  // Symptoms
  ['R50.9', 'Fever, unspecified', ['fever', 'pyrexia']],
];

module.exports = { ICD10_STARTER };

/**
 * Starting episode intervals (days) for codes where the system default
 * (14 days) does not fit: chronic conditions and antenatal care are seen
 * at every visit, so they count at most once a month per patient; a
 * delivery counts once per pregnancy. The system admin can change any of
 * these, and the default, on the Insights page.
 */
const STARTER_INTERVALS = {
  I10: 30, 'I50.9': 30, 'E11.9': 30, 'E10.9': 30, 'E66.9': 30, B24: 30, 'B18.1': 30, 'J45.9': 30, 'J44.9': 30,
  'D57.1': 30, 'N18.9': 30, 'K74.6': 30, N40: 30, 'G40.9': 30, 'F20.9': 30, 'F32.9': 30, 'H26.9': 30,
  'C50.9': 30, 'C53.9': 30, C61: 30, 'Z34.9': 30, 'M54.5': 30, 'A15.0': 30,
  O80: 280, O82: 280,
};

module.exports.STARTER_INTERVALS = STARTER_INTERVALS;
