/**
 * vocabs.ts – WLO Vocabulary mappings
 *
 * Resolves human-readable labels (German) ↔ full URIs for
 * Bildungsstufe, Zielgruppe, Schulfach, Lernressourcentyp (aggregiert),
 * Lizenzen und Themenseiten-Zielgruppen.
 *
 * **Authoritative sources (offizielle SKOS-Vokabulare):**
 *   - Schulfächer (this file's `discipline` map):
 *     https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/discipline/index.json
 *   - Bildungsstufen:
 *     https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/educationalContext/index.json
 *   - Zielgruppen (intendedEndUserRole):
 *     https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/intendedEndUserRole/index.json
 *   - Lernressourcentypen (aggregiert):
 *     https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/new_lrt_aggregated/index.json
 *
 * **Bewusst NICHT enthalten:** Hochschulfächersystematik
 *     https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/hochschulfaechersystematik/index.json
 *
 * Begründung: Das Vokabular hat ~100+ Konzepte mit Top-Level-Bereichen
 * wie "Mathematik, Naturwissenschaften" (n4) — Begriffe kollidieren mit
 * dem Schulfächer-Vokabular (z.B. "Mathematik" → discipline/380 vs.
 * Hochschul-n4 = breiter Cluster). Lokale Resolution wäre für die
 * *Eingabe-Seite* (User-Filter) ambig und könnte ungewollt zu breit
 * filtern.
 *
 * Anzeige (URI → Label) wird stattdessen über das server-seitige
 * `<property>_DISPLAYNAME`-Feld der edu-sharing-API in `formatter.ts`
 * abgewickelt — das deckt beide Vokabulare automatisch ab, ohne lokale
 * Hochschul-Mappings zu pflegen.
 */

export type VocabKey = 'educationalContext' | 'discipline' | 'userRole' | 'lrt' | 'license' | 'targetGroup';

interface VocabEntry {
  id: string;     // full URI
  labels: string[]; // prefLabel + altLabel (lowercase for matching)
}

// ── Bildungsstufe ────────────────────────────────────────────────────────────
const EC_BASE = 'http://w3id.org/openeduhub/vocabs/educationalContext/';

const EDUCATIONAL_CONTEXT: VocabEntry[] = [
  { id: EC_BASE + 'elementarbereich',  labels: ['elementarbereich', 'elementarstufe', 'elementary level', 'elementary school', 'kita', 'kindergarten'] },
  { id: EC_BASE + 'schule',            labels: ['schule', 'school'] },
  { id: EC_BASE + 'grundschule',       labels: ['primarstufe', 'grundschule', 'primary school', 'elementary school', 'primär'] },
  { id: EC_BASE + 'sekundarstufe_1',   labels: ['sekundarstufe i', 'sekundarstufe 1', 'secondary i', 'lower secondary school', 'sek i', 'sek1', 'sekundarstufe1'] },
  { id: EC_BASE + 'sekundarstufe_2',   labels: ['sekundarstufe ii', 'sekundarstufe 2', 'secondary ii', 'upper secondary school', 'sek ii', 'sek2', 'gymnasium', 'oberstufe'] },
  { id: EC_BASE + 'hochschule',        labels: ['hochschule', 'higher education', 'universität', 'uni', 'studium', 'hochschulbildung'] },
  { id: EC_BASE + 'berufliche_bildung',labels: ['berufliche bildung', 'vocational education', 'berufsausbildung', 'berufsschule', 'ausbildung'] },
  { id: EC_BASE + 'fortbildung',       labels: ['fortbildung', 'further education', 'weiterbildung', 'fortbildungen'] },
  { id: EC_BASE + 'erwachsenenbildung',labels: ['erwachsenenbildung', 'continuing education', 'erwachsene'] },
  { id: EC_BASE + 'foerderschule',     labels: ['förderschule', 'special education', 'sonderpädagogische förderung', 'förderung'] },
  { id: EC_BASE + 'fernunterricht',    labels: ['fernunterricht', 'distance learning', 'fernstudium', 'e-learning'] },
  { id: EC_BASE + 'informelles_lernen',labels: ['informelles lernen', 'informal learning'] },
];

// ── Zielgruppe ───────────────────────────────────────────────────────────────
const UR_BASE = 'http://w3id.org/openeduhub/vocabs/intendedEndUserRole/';

const USER_ROLE: VocabEntry[] = [
  { id: UR_BASE + 'author',      labels: ['autor/in', 'autor', 'autorin', 'author'] },
  { id: UR_BASE + 'counsellor',  labels: ['berater/in', 'berater', 'beraterin', 'counsellor', 'ratgeber/in'] },
  { id: UR_BASE + 'learner',     labels: ['lerner/in', 'lernende', 'lernender', 'schüler', 'schülerin', 'learner', 'students'] },
  { id: UR_BASE + 'manager',     labels: ['verwaltung', 'manager', 'schulleitung', 'leitung'] },
  { id: UR_BASE + 'parent',      labels: ['eltern', 'parent', 'elter', 'elternteil', 'erziehungsberechtigter', 'sorgeberechtigter'] },
  { id: UR_BASE + 'teacher',     labels: ['lehrer/in', 'lehrer', 'lehrerin', 'lehrende', 'lehrender', 'teacher', 'lehrkraft', 'pädagoge', 'pädagogin'] },
  { id: UR_BASE + 'other',       labels: ['andere', 'other', 'sonstige'] },
];

// ── Schulfächer ──────────────────────────────────────────────────────────────
const DISC_BASE = 'http://w3id.org/openeduhub/vocabs/discipline/';

const DISCIPLINE: VocabEntry[] = [
  { id: DISC_BASE + '720',    labels: ['allgemein', 'interdisciplinary media', 'sonstiges', 'fächerübergreifend'] },
  { id: DISC_BASE + '20003',  labels: ['alt-griechisch', 'ancient greek', 'griechisch'] },
  { id: DISC_BASE + '04001',  labels: ['agrarwirtschaft', 'agricultural economics', 'landwirtschaft'] },
  { id: DISC_BASE + 'oeh01',  labels: ['arbeit, ernährung, soziales'] },
  { id: DISC_BASE + '020',    labels: ['arbeitslehre', 'career education', 'arbeit wirtschaft technik', 'awt', 'polytechnik'] },
  { id: DISC_BASE + '04014',  labels: ['arbeitssicherheit', 'work safety'] },
  { id: DISC_BASE + '46014',  labels: ['astronomie', 'astronomy'] },
  { id: DISC_BASE + '04002',  labels: ['bautechnik', 'construction engineering'] },
  { id: DISC_BASE + '040',    labels: ['berufliche bildung', 'vocational education', 'berufsausbildung'] },
  { id: DISC_BASE + '080',    labels: ['biologie', 'biology', 'bio'] },
  { id: DISC_BASE + '100',    labels: ['chemie', 'chemistry'] },
  { id: DISC_BASE + '20041',  labels: ['chinesisch', 'chinese'] },
  { id: DISC_BASE + '12002',  labels: ['darstellendes spiel', 'performing game', 'theater', 'theaterpädagogik'] },
  { id: DISC_BASE + '120',    labels: ['deutsch', 'german as mother tongue', 'muttersprache', 'german'] },
  { id: DISC_BASE + '28002',  labels: ['deutsch als zweitsprache', 'german as second language', 'daz', 'daf', 'deutsch als fremdsprache'] },
  { id: DISC_BASE + '04005',  labels: ['elektrotechnik', 'electrical engineering'] },
  { id: DISC_BASE + '04006',  labels: ['ernährung und hauswirtschaft', 'nutrition and home economics'] },
  { id: DISC_BASE + '20001',  labels: ['englisch', 'english'] },
  { id: DISC_BASE + '440',    labels: ['pädagogik', 'pedagogy', 'erziehungswissenschaften', 'erziehungswissenschaft'] },
  { id: DISC_BASE + '20090',  labels: ['esperanto'] },
  { id: DISC_BASE + '160',    labels: ['ethik', 'ethics', 'werte und normen'] },
  { id: DISC_BASE + '04007',  labels: ['farbtechnik und raumgestaltung', 'color technology and interior design', 'raumgestaltung'] },
  { id: DISC_BASE + '20002',  labels: ['französisch', 'french', 'franzoesisch'] },
  { id: DISC_BASE + '220',    labels: ['geografie', 'geography', 'erdkunde', 'geographie', 'geo'] },
  { id: DISC_BASE + '240',    labels: ['geschichte', 'history'] },
  { id: DISC_BASE + '48005',  labels: ['gesellschaftskunde', 'social studies', 'gesellschaftspolitische gegenwartsfragen'] },
  { id: DISC_BASE + '260',    labels: ['gesundheit', 'health education', 'gesundheitserziehung'] },
  { id: DISC_BASE + '50001',  labels: ['hauswirtschaft', 'home economics', 'verbraucherbildung'] },
  { id: DISC_BASE + '04009',  labels: ['holztechnik', 'wood engineering'] },
  { id: DISC_BASE + '320',    labels: ['informatik', 'ict', 'computer science', 'informationstechnologie', 'it', 'info'] },
  { id: DISC_BASE + '340',    labels: ['interkulturelle bildung', 'intercultural education'] },
  { id: DISC_BASE + '20004',  labels: ['italienisch', 'italian'] },
  { id: DISC_BASE + '060',    labels: ['kunst', 'art education', 'kunsterziehung', 'art'] },
  { id: DISC_BASE + '04010',  labels: ['körperpflege', 'body care'] },
  { id: DISC_BASE + '20005',  labels: ['latein', 'latin'] },
  { id: DISC_BASE + '380',    labels: ['mathematik', 'mathematics', 'mathe', 'math'] },
  { id: DISC_BASE + 'oeh04010', labels: ['mechatronik'] },
  { id: DISC_BASE + '900',    labels: ['medienbildung', 'media education'] },
  { id: DISC_BASE + '400',    labels: ['mediendidaktik', 'media education', 'medienerziehung'] },
  { id: DISC_BASE + '04011',  labels: ['metalltechnik', 'metal engineering'] },
  { id: DISC_BASE + '04003',  labels: ['mint', 'chemie physik biologie', 'naturwissenschaften', 'natural sciences', 'stem'] },
  { id: DISC_BASE + '420',    labels: ['musik', 'music'] },
  { id: DISC_BASE + '64018',  labels: ['nachhaltigkeit', 'sustainability', 'bne', 'bildung für nachhaltige entwicklung'] },
  { id: DISC_BASE + 'niederdeutsch', labels: ['niederdeutsch', 'platt german', 'platt'] },
  { id: DISC_BASE + '44099',  labels: ['open educational resources', 'oer'] },
  { id: DISC_BASE + '450',    labels: ['philosophie', 'philosophy'] },
  { id: DISC_BASE + '460',    labels: ['physik', 'physics'] },
  { id: DISC_BASE + '480',    labels: ['politik', 'politics', 'politische bildung', 'sozialkunde'] },
  { id: DISC_BASE + '510',    labels: ['psychologie', 'psychology'] },
  { id: DISC_BASE + '520',    labels: ['religion', 'religious education', 'religionsunterricht', 'reli'] },
  { id: DISC_BASE + '20006',  labels: ['russisch', 'russian'] },
  { id: DISC_BASE + '28010',  labels: ['sachunterricht', 'homeland lessons', 'heimatunterricht', 'sachkunde'] },
  { id: DISC_BASE + '560',    labels: ['sexualerziehung', 'sex education'] },
  { id: DISC_BASE + '44006',  labels: ['sonderpädagogik', 'special needs education'] },
  { id: DISC_BASE + '20009',  labels: ['sorbisch', 'sorbian'] },
  { id: DISC_BASE + '44007',  labels: ['sozialpädagogik', 'social education'] },
  { id: DISC_BASE + '20007',  labels: ['spanisch', 'spanish'] },
  { id: DISC_BASE + '600',    labels: ['sport', 'physical education', 'sportunterricht'] },
  { id: DISC_BASE + '04012',  labels: ['textiltechnik und bekleidung', 'textile technology and clothing'] },
  { id: DISC_BASE + '20008',  labels: ['türkisch', 'turkish'] },
  { id: DISC_BASE + '04013',  labels: ['wirtschaft und verwaltung', 'business and administration'] },
  { id: DISC_BASE + '700',    labels: ['wirtschaftskunde', 'economics', 'wirtschaftswissenschaften', 'economy', 'vwl', 'bwl'] },
  { id: DISC_BASE + '640',    labels: ['umweltgefährdung umweltschutz', 'environmental education', 'umwelterziehung', 'umwelt'] },
  { id: DISC_BASE + '660',    labels: ['verkehrserziehung', 'road safety education'] },
  { id: DISC_BASE + '680',    labels: ['weiterbildung', 'further education'] },
  { id: DISC_BASE + '50005',  labels: ['werken', 'handicraft', 'textiles werken'] },
  { id: DISC_BASE + '72001',  labels: ['zeitgemäße bildung', 'modern education', 'digitale bildung'] },
  { id: DISC_BASE + '72002',  labels: ['projektmanagement', 'project management'] },
  { id: DISC_BASE + '72003',  labels: ['evidenzbasierte medizin', 'evidence-based medicine'] },
  { id: DISC_BASE + '999',    labels: ['sonstiges', 'other'] },
];

// ── Lernressourcentyp (aggregiert) ──────────────────────────────────────────
const LRT_BASE = 'http://w3id.org/openeduhub/vocabs/new_lrt_aggregated/';

const LRT: VocabEntry[] = [
  { id: LRT_BASE + 'b8fb5fb2-d8bf-4bbe-ab68-358b65a26bed', labels: ['bild', 'image'] },
  { id: LRT_BASE + '38774279-af36-4ec2-8e70-811d5a51a6a1', labels: ['video'] },
  { id: LRT_BASE + '39197d6f-dfb1-4e82-92e5-79f906e9d2a9', labels: ['audio', 'podcast'] },
  { id: LRT_BASE + '05aa0f49-7e1b-498b-a7d5-c5fc8e73b2e2', labels: ['interaktives medium', 'interactive media', 'interaktiv', 'simulation'] },
  { id: LRT_BASE + '11f438d7-cb11-49c2-8e67-2dd7df677092', labels: ['unterrichtsidee', 'lesson idea'] },
  { id: LRT_BASE + '8526273b-2b21-46f2-ac8d-bbf362c8a690', labels: ['unterrichtsplan', 'lesson plan'] },
  { id: LRT_BASE + 'f1341358-3f91-449b-b6eb-f58636f756a0', labels: ['unterrichtsbaustein', 'unterrichtsreihe', 'lesson unit'] },
  { id: LRT_BASE + '101c0c66-5202-4eba-9ebf-79f4903752b9', labels: ['methoden', 'methods'] },
  { id: LRT_BASE + '02bfd0fe-96ab-4dd6-a306-ec362ec25ea0', labels: ['tests', 'fragebögen', 'test', 'fragebogen', 'quiz'] },
  { id: LRT_BASE + 'e10e9add-700e-4b57-a9c5-8f1088bb0545', labels: ['kurs', 'course'] },
  { id: LRT_BASE + '3469a5e7-86d1-4376-bd3d-1f2b183ed94a', labels: ['lernobjekt', 'lernpfad', 'learning path'] },
  { id: LRT_BASE + '1e300ea3-a687-45a3-b215-9c240c1666dc', labels: ['präsentation', 'presentation', 'folien', 'slides'] },
  { id: LRT_BASE + 'ded96854-280a-45ac-ad3a-f5b9b8dd0a03', labels: ['lernspiel', 'learning game', 'spiel', 'game'] },
  { id: LRT_BASE + 'c8e52242-361b-4a2a-b95d-25e516b28b45', labels: ['arbeitsblatt', 'worksheet'] },
  { id: LRT_BASE + '0b2d7dec-8eb1-4a28-9cf2-4f3a4f5a511b', labels: ['übungsmaterial', 'exercise material', 'übung'] },
  { id: LRT_BASE + '90a082d8-ee5f-4b33-bd5c-f1738262c47d', labels: ['recherche', 'lernauftrag', 'research task'] },
  { id: LRT_BASE + 'ffe4d8e8-3cfd-4e9a-b025-83f129eb5c9d', labels: ['experiment'] },
  { id: LRT_BASE + '71c71f72-fc8d-4263-902f-abf1366a73ca', labels: ['projekt-material', 'project material', 'projekt'] },
  { id: LRT_BASE + '57bfc743-4c94-4bdd-bdfa-c638a062d151', labels: ['kreative aktivität', 'kreativ', 'creative activity'] },
  { id: LRT_BASE + 'ec402e87-c623-47e2-8d2e-1c4ea6923409', labels: ['entdeckendes lernen', 'discovery learning'] },
  { id: LRT_BASE + 'd0c115e4-848d-4aea-8e31-23869e9add3e', labels: ['rollenspiel', 'role play'] },
  { id: LRT_BASE + '41eaccae-899b-4209-8a54-c793a3cdf538', labels: ['fallstudie', 'case study'] },
  { id: LRT_BASE + 'c77df53a-2611-4029-9712-f9c0eeb032a3', labels: ['artikel', 'article'] },
  { id: LRT_BASE + '3927fdb6-0477-422c-9f5a-6285948aeaf4', labels: ['buch', 'lehrbuch', 'book', 'textbook'] },
  { id: LRT_BASE + '9abf6ace-85bc-44e2-af4f-93a6bd255a21', labels: ['handout'] },
  { id: LRT_BASE + 'fece0442-c686-4496-b97e-06d87782009b', labels: ['schülerarbeit', 'student work'] },
  { id: LRT_BASE + '854e5bcf-d898-43ca-bc70-caf2a7e33673', labels: ['noten', 'sheet music', 'musiknoten'] },
  { id: LRT_BASE + '99f3bb30-22c0-4b46-871c-43ab4b6baf6f', labels: ['checkliste', 'checklist'] },
  { id: LRT_BASE + 'ac925aae-1f3c-4817-a9dd-b9b24c336b0d', labels: ['regularien', 'handbuch', 'manual'] },
  { id: LRT_BASE + '55761ec6-0cd4-4677-86ee-6f395934dae7', labels: ['webseite', 'website', 'webpage'] },
  { id: LRT_BASE + 'ac4987d7-5d09-4a21-82c6-268ed6cdc7eb', labels: ['webblog', 'blog'] },
  { id: LRT_BASE + '6f669beb-273a-4153-bdb6-4c6d59b2366d', labels: ['wiki'] },
  { id: LRT_BASE + '9337a93e-777d-4d76-99a5-51f5e9935e63', labels: ['wortliste', 'vokabelliste', 'vocabulary list'] },
  { id: LRT_BASE + 'cf8929a7-d521-4f17-bbe3-96748c862486', labels: ['nachschlagewerk', 'reference work', 'lexikon'] },
  { id: LRT_BASE + '1c610f61-9bf0-4d77-8536-b713a3733510', labels: ['primärmaterial', 'primary source'] },
  { id: LRT_BASE + '37a3ad9c-727f-4b74-bbab-27d59015c695', labels: ['tool', 'werkzeug', 'app'] },
  { id: LRT_BASE + '6b6786df-9ce9-44bf-8a04-caebd4456fcf', labels: ['bildungsangebot', 'educational offer'] },
  { id: LRT_BASE + 'b06c5816-60c7-4f1b-bcd7-95d70aaa4740', labels: ['event', 'wettbewerb', 'competition'] },
  { id: LRT_BASE + '9bbb50a2-10c5-4a8b-9e0e-6a5fc86c40fe', labels: ['news', 'nachricht'] },
  { id: LRT_BASE + '2e678af3-1026-4171-b88e-3b3a915d1673', labels: ['quelle', 'source'] },
];

// ── Lizenzen ─────────────────────────────────────────────────────────────────
// edu-sharing stores license keys (ccm:commonlicense_key) like "CC_BY_SA".
// We map them to human-readable labels here for consistent output.

// NOTE: For licenses we store the *display form* as the primary label
// (e.g. "CC BY-SA 4.0" instead of "cc by-sa 4.0"). Capitalize-logic in
// labelFromUri only kicks in for fully-lowercase primary labels — otherwise
// "cc by-sa 4.0" would render as the unhelpful "Cc by-sa 4.0".
const LICENSE: VocabEntry[] = [
  { id: 'CC_0',         labels: ['CC 0', 'cc0', 'public domain dedication'] },
  { id: 'PDM',          labels: ['Public Domain Mark', 'gemeinfrei'] },
  { id: 'CC_BY',        labels: ['CC BY 4.0', 'creative commons by'] },
  { id: 'CC_BY_SA',     labels: ['CC BY-SA 4.0', 'creative commons by-sa'] },
  { id: 'CC_BY_ND',     labels: ['CC BY-ND 4.0', 'creative commons by-nd'] },
  { id: 'CC_BY_NC',     labels: ['CC BY-NC 4.0', 'creative commons by-nc'] },
  { id: 'CC_BY_NC_SA',  labels: ['CC BY-NC-SA 4.0', 'creative commons by-nc-sa'] },
  { id: 'CC_BY_NC_ND',  labels: ['CC BY-NC-ND 4.0', 'creative commons by-nc-nd'] },
  { id: 'COPYRIGHT_FREE', labels: ['urheberrechtsfrei', 'copyright free'] },
  { id: 'CUSTOM',       labels: ['Individuelle Lizenz', 'custom'] },
  { id: 'NONE',         labels: ['Keine Angabe', 'no license info'] },
  { id: 'SCHULFUNK',    labels: ['Schulfunk §47 UrhG', 'schulfunk'] },
];

// ── Themenseiten-Zielgruppe ──────────────────────────────────────────────────
// `ccm:page_variant_profiling_target_group` is sometimes a slug,
// sometimes a URI. Map both to readable German labels.

const TARGET_GROUP: VocabEntry[] = [
  { id: 'teacher',  labels: ['lehrkräfte', 'lehrkraefte', 'lehrer', 'lehrerinnen', 'teacher'] },
  { id: 'learner',  labels: ['lernende', 'schüler', 'schueler', 'schülerinnen', 'learner', 'students'] },
  { id: 'general',  labels: ['allgemein', 'general', 'public'] },
];

// ── Generic resolver ─────────────────────────────────────────────────────────

const VOCAB_MAP: Record<VocabKey, VocabEntry[]> = {
  educationalContext: EDUCATIONAL_CONTEXT,
  discipline: DISCIPLINE,
  userRole: USER_ROLE,
  lrt: LRT,
  license: LICENSE,
  targetGroup: TARGET_GROUP,
};

/** Resolve a label or URI to a full URI. Returns null if nothing matches. */
export function resolveVocab(input: string, vocab: VocabKey): string | null {
  if (!input?.trim()) return null;
  const trimmed = input.trim();

  // Already a URI
  if (trimmed.startsWith('http')) return trimmed;

  const lower = trimmed.toLowerCase();
  const entries = VOCAB_MAP[vocab];
  // 1) Exact label/alias match wins — precise and order-independent.
  for (const entry of entries) {
    if (entry.labels.some(l => l.toLowerCase() === lower)) return entry.id;
  }
  // 2) Fuzzy fallback, but ONLY between tokens of length >= 4 on both sides.
  //    The old unbounded bidirectional `includes` mis-resolved short inputs
  //    (e.g. "it" → "arbeit", "uni" → "kommunikation") and was order-
  //    dependent. The length guard kills the short-token false positives
  //    while keeping legitimate fuzzy matches for longer terms.
  for (const entry of entries) {
    if (entry.labels.some(l => {
      const ll = l.toLowerCase();
      if (ll.length < 4 || lower.length < 4) return false;
      return ll.includes(lower) || lower.includes(ll);
    })) {
      return entry.id;
    }
  }
  return null;
}

/** Extract the trailing slug from a URI: ".../teacher" → "teacher" */
function trailingSlug(uri: string): string {
  if (!uri) return '';
  const cleaned = uri.split(/[#?]/, 1)[0]!.replace(/\/+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf(':'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Get German label for a URI/key, or the original input as fallback. */
export function labelFromUri(uri: string, vocab: VocabKey): string {
  if (!uri) return uri;
  const entries = VOCAB_MAP[vocab];

  // Direct match (full URI or simple key)
  let entry = entries.find(e => e.id === uri);

  // Trailing-slug match for namespaced values like "ccrep://.../teacher"
  if (!entry) {
    const slug = trailingSlug(uri).toLowerCase();
    if (slug) {
      entry = entries.find(e => {
        const eSlug = trailingSlug(e.id).toLowerCase();
        return eSlug === slug;
      });
    }
  }

  // Label/alias match (case-insensitive) for inputs that are already labels
  if (!entry) {
    const lower = uri.toLowerCase();
    entry = entries.find(e => e.labels.some(l => l.toLowerCase() === lower));
  }

  if (!entry) return uri;
  const first = entry.labels[0];
  // If the primary label has any uppercase already (e.g. "CC BY-SA 4.0"),
  // assume the vocab author chose the display form deliberately — don't
  // mangle it. Otherwise capitalize the first character so plain-lowercase
  // labels like "mathematik" become "Mathematik".
  if (/[A-ZÄÖÜ]/.test(first)) return first;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Return all entries of a vocabulary (for lookup tool). */
export function listVocab(vocab: VocabKey): Array<{ uri: string; label: string; aliases: string[] }> {
  return VOCAB_MAP[vocab].map(e => ({
    uri: e.id,
    label: e.labels[0].charAt(0).toUpperCase() + e.labels[0].slice(1),
    aliases: e.labels.slice(1),
  }));
}
