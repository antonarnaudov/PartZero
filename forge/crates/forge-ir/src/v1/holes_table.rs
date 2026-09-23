// HOLE_SIZES data (SPEC-v1 §6.5), verified 2026-09-23 against the published tables below.
// Every value cites at least two independent sources, except where a note says otherwise.
// Changing any value is a hole feature `v` bump (IR-V1 plan, risks).

/// Source id → citation (document id and URL actually checked).
#[rustfmt::skip]
pub const SOURCES: &[(&str, &str)] = &[
    ("iso2306", "ISO 2306:1972 Drills for use prior to tapping screw threads, Table 1 (official preview): https://cdn.standards.iteh.ai/samples/7135/5bef5f85e78040d6b848307ffd62d83f/ISO-2306-1972.pdf"),
    ("wiki-iso-thread", "ISO 261/262 coarse pitches as tabulated at https://en.wikipedia.org/wiki/ISO_metric_screw_thread"),
    ("fractory-tap", "Fractory metric tap drill chart: https://fractory.com/metric-tap-drill-chart/"),
    ("anzugsmoment-tap", "anzugsmoment.de Kernlochdurchmesser (M2.5 tap drill 2.1): https://www.anzugsmoment.de/kernlochdurchmesser/"),
    ("optimas-tap", "Optimas tapping sizes (M8 tap drill 6.75): https://international.optimas.com/technical-resources/tapping-sizes/"),
    ("iso273", "ISO 273:1979 Fasteners - Clearance holes for bolts and screws, Table 1 fine/medium/coarse (official preview): https://cdn.standards.iteh.ai/samples/4183/1a8db2e6de054d2e9bed7d40be64d6e1/ISO-273-1979.pdf"),
    ("eh-clearance", "Engineering Hardware clearance hole sizes (ISO 273): https://engineeringhardware.com/fastener/clearance-hole-sizes/"),
    ("ifanger-din974", "DIN 974-1 counterbores (Flachsenkungen nach DIN 974-1, row 1), Ifanger tool catalog p. 32: https://www.defruytier.be/uploads/product/files/ifanger-VFL.pdf"),
    ("engineersbible-cbore", "Engineers Bible counterbore for ISO 4762 socket head cap screws: https://engineersbible.com/counterbore-socket-iso/"),
    ("ingenieurkurse-din974", "ingenieurkurse.de, DIN 974-1 row 1 (ISO 4762 without washer) diameters and depths: https://www.ingenieurkurse.de/technische-darstellungen-maschienenbau/normgerechtes-bemassen-in-einer-technischen-zeichnung/hinweise-zu-speziellen-schrauben-und-gewindebedingungen.html"),
    ("neue-physik-senkungen", "neue-physik.de Senkungen (DIN 974-1, DIN 74): https://www.neue-physik.de/353.9_Senkungen.php"),
    ("schraube-mutter-cbore", "schraube-mutter.de Bohrtabelle fuer Zylinderschrauben (counterbore depths): https://schraube-mutter.de/bohrtabelle-fuer-zylinderschrauben/"),
    ("iso4762", "DIN EN ISO 4762 head height k and head diameter dk (full text as published at https://bolt.msk.ru/standards/DIN%20EN%20ISO%204762.pdf; also https://www.fasteners.eu/standards/ISO/4762/)"),
    ("ifanger-din74", "DIN 74:2003-04 Form F (countersinks for ISO 10642 heads), Ifanger tool catalog p. 32: https://www.defruytier.be/uploads/product/files/ifanger-VFL.pdf"),
    ("smw-din74", "SMW Schrauben Senkschrauben datasheet, DIN 74 Form F d2 for ISO 10642: https://www.smw-schrauben.ch/userdata/uploads/downloads/Senkschrauben.pdf"),
    ("iso10642", "DIN EN ISO 10642:2020 Tables 1-2, head diameter dk theoretical max (official preview): https://www.normsplash.com/FreeDownload/134855393/DIN-EN-ISO-10642-2020-en.pdf"),
    ("ruthex", "ruthex threaded inserts dimension table (RX-M2x4 ... RX-M8x12.7; minimum hole depth = length + 1 mm): https://www.ruthex.de/en/products/ruthex-gewindeeinsatz-m3-100-stuck-rx-m3x5-7-messing-gewindebuchsen"),
    ("cnckitchen", "CNC Kitchen heat-set insert metric table (April 2026; minimum hole depth = length + 1 mm): https://cnckitchen.store/products/heat-set-insert-m3-x-5-7-100-pieces"),
    ("cnckitchen-3djake", "Older CNC Kitchen insert data (M4-M6 bores 5.6 / 6.4 / 8.0) on the 3DJake resale pages: https://www.3djake.com/cnc-kitchen/threaded-inserts-m4-standard"),
];

/// Values omitted because two independent published tables could not be found or agree:
/// `(size, field, reason)`. A preset needing one of them is rejected for that size.
#[rustfmt::skip]
pub const UNVERIFIED: &[(&str, &str, &str)] = &[
    ("M2", "cbore_depth", "published DIN 974-1-style depths disagree: 2.1 (schraube-mutter.de), 2.2 (engineersbible.com), 2.3 (GB/T 152.3); no two sources agree"),
    ("M2", "csink_d", "ISO 10642:2019 added M2 but the DIN 74:2020 Form F countersink value could not be obtained; ISO 15065's 4.4 is for ISO 7721 heads and is smaller than the ISO 10642 head (dk theoretical max 4.70)"),
    ("M2.5", "csink_d", "ISO 10642:2019 added M2.5 but the DIN 74:2020 Form F countersink value could not be obtained; ISO 15065's 5.5 is for ISO 7721 heads and is smaller than the ISO 10642 head (dk theoretical max 5.88)"),
];

const PITCH: &[&str] = &["iso2306", "wiki-iso-thread"];
const TAP: &[&str] = &["iso2306", "fractory-tap"];
const CLEAR: &[&str] = &["iso273", "eh-clearance"];
const CB_SMALL: &[&str] = &["ifanger-din974", "engineersbible-cbore"];
const CB_M3: &[&str] = &["ifanger-din974", "ingenieurkurse-din974", "neue-physik-senkungen"];
const CB: &[&str] = &["ingenieurkurse-din974", "neue-physik-senkungen"];
const CB_DEPTH: &[&str] = &["ingenieurkurse-din974", "neue-physik-senkungen", "schraube-mutter-cbore"];
const CSINK: &[&str] = &["ifanger-din74", "smw-din74"];
const INSERT: &[&str] = &["ruthex", "cnckitchen"];
const INSERT_OLD: &[&str] = &["ruthex", "cnckitchen-3djake"];

/// The table, one row per [`HoleSize`], in size order.
#[rustfmt::skip]
pub const HOLE_SIZES: [HoleRow; 7] = [
    HoleRow {
        size: HoleSize::M2,
        pitch: v(0.4, PITCH), tap: v(1.6, TAP),
        close: v(2.2, CLEAR), normal: v(2.4, CLEAR), loose: v(2.6, CLEAR),
        cbore_d: v(4.4, CB_SMALL),
        cbore_depth: None,
        csink_d: None,
        insert_d: v(3.2, INSERT),
        insert_depth: vn(5.0, INSERT, "makers differ in the standard M2 length: ruthex RX-M2x4 (4.0 mm), CNC Kitchen M2x3 (3.0 mm); both specify a minimum hole depth of length + 1 mm. The deeper hole (4.0 + 1) is chosen: it seats either insert without bottoming out"),
    },
    HoleRow {
        size: HoleSize::M2_5,
        pitch: v(0.45, PITCH),
        tap: vn(2.05, TAP, "ISO 2306 value; some tables round to 2.1 (anzugsmoment.de, yako-sangyo.co.jp)"),
        close: v(2.7, CLEAR), normal: v(2.9, CLEAR), loose: v(3.1, CLEAR),
        cbore_d: v(5.5, CB_SMALL),
        cbore_depth: vn(3.0, &["schraube-mutter-cbore", "engineersbible-cbore"], "two sources agree on 3.0, which does not follow the k + 0.4 pattern of M3-M6 (would be 2.9)"),
        csink_d: None,
        insert_d: v(4.0, INSERT),
        insert_depth: vn(6.7, INSERT, "makers differ in the standard M2.5 length: ruthex RX-M2.5x5.7 (5.7 mm), CNC Kitchen M2.5x4 (4.0 mm); the deeper hole (5.7 + 1) is chosen: it seats either insert"),
    },
    HoleRow {
        size: HoleSize::M3,
        pitch: v(0.5, PITCH), tap: v(2.5, TAP),
        close: v(3.2, CLEAR), normal: v(3.4, CLEAR), loose: v(3.6, CLEAR),
        cbore_d: v(6.5, CB_M3),
        cbore_depth: v(3.4, CB_DEPTH),
        csink_d: v(6.94, CSINK),
        insert_d: v(4.0, INSERT),
        insert_depth: v(6.7, INSERT),
    },
    HoleRow {
        size: HoleSize::M4,
        pitch: v(0.7, PITCH), tap: v(3.3, TAP),
        close: v(4.3, CLEAR), normal: v(4.5, CLEAR), loose: v(4.8, CLEAR),
        cbore_d: v(8.0, CB),
        cbore_depth: v(4.4, CB_DEPTH),
        csink_d: v(9.18, CSINK),
        insert_d: vn(5.6, INSERT_OLD, "ruthex and older CNC Kitchen data: 5.6; CNC Kitchen's current table: 5.7"),
        insert_depth: v(9.1, INSERT),
    },
    HoleRow {
        size: HoleSize::M5,
        pitch: v(0.8, PITCH), tap: v(4.2, TAP),
        close: v(5.3, CLEAR), normal: v(5.5, CLEAR), loose: v(5.8, CLEAR),
        cbore_d: v(10.0, CB),
        cbore_depth: v(5.4, CB_DEPTH),
        csink_d: v(11.47, CSINK),
        insert_d: vn(6.4, INSERT_OLD, "ruthex and older CNC Kitchen data: 6.4; CNC Kitchen's current table: 6.5"),
        insert_depth: v(10.5, INSERT),
    },
    HoleRow {
        size: HoleSize::M6,
        pitch: v(1.0, PITCH), tap: v(5.0, TAP),
        close: v(6.4, CLEAR), normal: v(6.6, CLEAR), loose: v(7.0, CLEAR),
        cbore_d: v(11.0, CB),
        cbore_depth: v(6.4, CB_DEPTH),
        csink_d: v(13.71, CSINK),
        insert_d: vn(8.0, INSERT_OLD, "ruthex and older CNC Kitchen data: 8.0; CNC Kitchen's current table: 8.1"),
        insert_depth: v(13.7, INSERT),
    },
    HoleRow {
        size: HoleSize::M8,
        pitch: v(1.25, PITCH),
        tap: vn(6.8, TAP, "ISO 2306 value; Optimas lists d - P = 6.75"),
        close: v(8.4, CLEAR), normal: v(9.0, CLEAR), loose: v(10.0, CLEAR),
        cbore_d: v(15.0, CB),
        cbore_depth: v(8.6, CB_DEPTH),
        csink_d: v(18.25, CSINK),
        insert_d: vn(9.6, INSERT, "makers split: ruthex 9.6, CNC Kitchen 9.7 (CNC Kitchen's current table is +0.1 mm over ruthex for every size M4-M8); 9.6 keeps the preset on the same maker series as M4-M6, where ruthex is the majority value"),
        insert_depth: v(13.7, INSERT),
    },
];
