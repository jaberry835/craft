import { Faker, en } from "@faker-js/faker";
import type { Organization, OutputArtifact, Person, ScenarioPack, SupportedLocale } from "../core/types.js";
import { writeTextFile } from "./outputWriter.js";

interface AdxColumn {
  name: string;
  type: "string" | "datetime" | "int" | "real";
}

interface CsvDataset {
  relativePath: string;
  description: string;
  sourceEntityIds: string[];
  header: string[];
  rows: Array<Array<string | number>>;
  adxTableName: string;
  adxColumns: AdxColumn[];
}

interface AddressRecord {
  addressId: string;
  personId: string;
  dataLanguage: SupportedLocale;
  role: string;
  addressLine1: string;
  addressLine2: string;
  district: string;
  city: string;
  region: string;
  postalCode: string;
  latitude: string;
  longitude: string;
}

interface VehicleRecord {
  vehicleId: string;
  ownerPersonId: string;
  primaryDriverPersonId: string;
  dataLanguage: SupportedLocale;
  ownerName: string;
  make: string;
  model: string;
  modelYear: number;
  color: string;
  vehicleType: string;
  tagNumber: string;
  registrationNumber: string;
  registeredAddressId: string;
  registrationIssuedAt: string;
  activeFrom: string;
  activeTo: string;
}

interface TollBoothRecord {
  boothId: string;
  dataLanguage: SupportedLocale;
  boothName: string;
  roadName: string;
  district: string;
  city: string;
  region: string;
  latitude: string;
  longitude: string;
  lanes: number;
  directionServed: string;
}

interface TollTransactionRecord {
  transactionId: string;
  vehicleId: string;
  ownerPersonId: string;
  driverPersonId: string;
  dataLanguage: SupportedLocale;
  tagNumber: string;
  boothId: string;
  boothName: string;
  transactedAt: string;
  tollAmountLocal: string;
  currency: string;
  paymentStatus: string;
  laneId: string;
  direction: string;
  plateCaptured: string;
  vehicleMake: string;
  vehicleModel: string;
  driverNote: string;
}

interface BorderCrossingRecord {
  crossingId: string;
  manifestId: string;
  travelerPersonId: string;
  dataLanguage: SupportedLocale;
  travelerName: string;
  passportNumber: string;
  passportCountryCode: string;
  nationality: string;
  crossingDirection: string;
  airportCode: string;
  airportName: string;
  flightNumber: string;
  carrierName: string;
  originCountryCode: string;
  originCountryName: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  recordedAt: string;
  terminal: string;
  gate: string;
  seatNumber: string;
  baggageCount: number;
  travelPurpose: string;
  visaStatus: string;
  inspectionResult: string;
  officerNote: string;
}

interface FlightManifestRecord {
  manifestId: string;
  manifestSequence: number;
  dataLanguage: SupportedLocale;
  flightNumber: string;
  carrierName: string;
  travelDirection: string;
  airportCode: string;
  originCountryCode: string;
  originCountryName: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  departureAt: string;
  arrivalAt: string;
  travelerPersonId: string;
  travelerName: string;
  passportNumber: string;
  nationality: string;
  seatNumber: string;
  checkedBagCount: number;
  boardingZone: string;
  manifestNote: string;
}

interface TravelBookingRecord {
  bookingId: string;
  manifestId: string;
  travelerPersonId: string;
  dataLanguage: SupportedLocale;
  travelerName: string;
  bookingReference: string;
  bookingChannel: string;
  bookingStatus: string;
  bookedAt: string;
  flightNumber: string;
  carrierName: string;
  originCountryCode: string;
  originCountryName: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  departureAt: string;
  arrivalAt: string;
  fareClass: string;
  tripPurpose: string;
}

interface HotelStayRecord {
  stayId: string;
  manifestId: string;
  travelerPersonId: string;
  dataLanguage: SupportedLocale;
  travelerName: string;
  hotelName: string;
  city: string;
  countryCode: string;
  countryName: string;
  checkInAt: string;
  checkOutAt: string;
  roomType: string;
  bookingStatus: string;
  paymentStatus: string;
  nightlyRateLocal: string;
  currency: string;
  stayPurpose: string;
}

interface PersonMentionRecord {
  mentionId: string;
  personId: string;
  personName: string;
  sourceTable: string;
  sourceRecordId: string;
  mentionField: string;
  mentionedValue: string;
  dataLanguage: SupportedLocale;
}

interface ManifestTrip {
  manifestId: string;
  travelDirection: string;
  airportCode: string;
  airportName: string;
  flightNumber: string;
  carrierName: string;
  originCountryCode: string;
  originCountryName: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  departureAt: string;
  arrivalAt: string;
  terminal: string;
  gate: string;
}

interface DataLanguageProfile {
  residenceRole: string;
  workRole: string;
  streetTypes: string[];
  districtWord: string;
  tollBoothPrefix: string;
  airportWord: string;
  terminalWord: string;
  gateWord: string;
  outbound: string;
  inbound: string;
  bidirectional: string;
  paymentStatuses: string[];
  purposes: string[];
  visaStatuses: string[];
  inspectionResults: string[];
  titleTranslations: Record<string, string>;
  givenNames: string[];
  familyNames: string[];
  nameOrder: "given-family" | "family-given";
  nameJoiner: string;
  streetBases: string[];
  districtPrefixes: string[];
  cityRoots: string[];
  roadRoots: string[];
  carrierRoots: string[];
  organizationRoots: {
    government: string[];
    company: string[];
    research: string[];
  };
  countryLabels: Record<string, string>;
  capitalLabels: Record<string, string>;
  regionLabels: Record<string, string>;
  demonymLabels: Record<string, string>;
  driverNoteTemplate: (name: string, boothName: string) => string;
  manifestNoteTemplate: (name: string, flightNumber: string) => string;
  officerNoteTemplate: (name: string, airportName: string) => string;
}

const vehicleCatalog = [
  { make: "Toyota", model: "Corolla", type: "sedan" },
  { make: "Honda", model: "CR-V", type: "suv" },
  { make: "Ford", model: "Ranger", type: "pickup" },
  { make: "Nissan", model: "Navara", type: "pickup" },
  { make: "Hyundai", model: "Tucson", type: "suv" },
  { make: "Kia", model: "Sportage", type: "suv" },
  { make: "Volkswagen", model: "Passat", type: "sedan" },
  { make: "Mazda", model: "CX-5", type: "suv" }
] as const;

const operationalColors = ["silver", "white", "black", "blue", "graphite", "green"];
const supportedDataLanguages: SupportedLocale[] = ["en", "ru", "zh", "ar", "es"];
const bookingChannels = ["portal", "agency", "desk", "direct"] as const;
const bookingStatuses = ["confirmed", "ticketed", "amended"] as const;
const fareClasses = ["economy", "premium-economy", "business"] as const;
const hotelRoomTypes = ["standard", "executive", "suite"] as const;
const hotelPaymentStatuses = ["paid", "pending", "company-billed"] as const;

function scaleMinimum(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale));
}

function scaledCount(faker: Faker, min: number, max: number, scale: number): number {
  return faker.number.int({
    min: scaleMinimum(min, scale),
    max: Math.max(scaleMinimum(min, scale), Math.round(max * scale))
  });
}

function escapeCsvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function buildCsv(header: string[], rows: Array<Array<string | number>>): string {
  return [header, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
    .join("\n");
}

function createFaker(seed: number): Faker {
  const faker = new Faker({ locale: [en] });
  faker.seed(seed);
  return faker;
}

function createCoordinate(faker: Faker, min: number, max: number): string {
  return faker.number.float({ min, max, fractionDigits: 4 }).toFixed(4);
}

function hashText(value: string): number {
  let hash = 0;

  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

function selectByKey(values: string[], key: string): string {
  return values[hashText(key) % values.length] ?? values[0] ?? "";
}

function createOrganizationLanguageMap(pack: ScenarioPack): Map<string, SupportedLocale> {
  const orderedLanguages = [pack.dataLanguage, ...supportedDataLanguages.filter((locale) => locale !== pack.dataLanguage)];

  return new Map(pack.organizations.map((organization) => {
    if (organization.kind === "government") {
      return [organization.id, pack.dataLanguage] as const;
    }

    const index = 1 + (hashText(`${organization.id}:${organization.kind}`) % (orderedLanguages.length - 1));
    return [organization.id, orderedLanguages[index] ?? pack.dataLanguage] as const;
  }));
}

function getPersonLanguage(person: Person, organizationLanguages: Map<string, SupportedLocale>, fallback: SupportedLocale): SupportedLocale {
  return organizationLanguages.get(person.organizationId) ?? fallback;
}

function getDataLanguageProfile(locale: SupportedLocale): DataLanguageProfile {
  const profiles: Record<SupportedLocale, DataLanguageProfile> = {
    en: {
      residenceRole: "residence",
      workRole: "worksite",
      streetTypes: ["Avenue", "Street", "Road", "Boulevard", "Lane"],
      districtWord: "District",
      tollBoothPrefix: "Toll Booth",
      airportWord: "International Airport",
      terminalWord: "Terminal",
      gateWord: "Gate",
      outbound: "outbound",
      inbound: "inbound",
      bidirectional: "bidirectional",
      paymentStatuses: ["captured", "settled", "reconciled"],
      purposes: ["business", "family visit", "conference", "inspection", "transit"],
      visaStatuses: ["visa waiver", "resident return", "business visa", "diplomatic clearance"],
      inspectionResults: ["cleared", "secondary review", "document verified"],
      titleTranslations: {
        "Senior Policy Analyst": "Senior Policy Analyst",
        "Deputy Director": "Deputy Director",
        "Research Coordinator": "Research Coordinator",
        "Commercial Strategy Lead": "Commercial Strategy Lead",
        "Trade Compliance Officer": "Trade Compliance Officer"
      },
      givenNames: ["Mara", "Jonah", "Elena", "Lucas", "Talia", "Owen", "Nadia", "Grant", "Mira", "Iris"],
      familyNames: ["Hart", "Mills", "Bennett", "Stone", "Mercer", "Quinn", "Dawson", "Frost", "Rowe", "Vale"],
      nameOrder: "given-family",
      nameJoiner: " ",
      streetBases: ["Harbor", "Foundry", "Lantern", "Canal", "Summit", "Market", "Civic", "Mineral"],
      districtPrefixes: ["Central", "North", "East", "South", "West"],
      cityRoots: ["Northreach", "Stonebridge", "Lakeside", "Cedar Point"],
      roadRoots: ["Harbor Express", "Mineral Route", "River Link", "Civic Ring", "Airport Spur", "Southern Bypass"],
      carrierRoots: ["Veloria Air", "Mariton International", "Blue Arc Airways", "Southern Isthmus Connect"],
      organizationRoots: {
        government: ["Ministry of Trade Coordination", "Bureau of Strategic Transit", "National Customs Secretariat"],
        company: ["North Harbor Logistics", "Civic Freight Systems", "Summit Fleet Group"],
        research: ["Institute for Applied Transit Studies", "Border Mobility Observatory", "Center for Route Analysis"]
      },
      countryLabels: {
        "country-veloria": "Veloria",
        "country-astriv": "Astriv",
        "country-demeris": "Demeris"
      },
      capitalLabels: {
        "country-veloria": "Mariton",
        "country-astriv": "Keral",
        "country-demeris": "Soreth"
      },
      regionLabels: {
        "country-veloria": "Southern Isthmus",
        "country-astriv": "Inner Continental Belt",
        "country-demeris": "Eastern Maritime Arc"
      },
      demonymLabels: {
        "country-veloria": "Velorian",
        "country-astriv": "Astrivan",
        "country-demeris": "Demerian"
      },
      driverNoteTemplate: (name, boothName) => `Tag observed on vehicle linked to ${name} at ${boothName}.`,
      manifestNoteTemplate: (name, flightNumber) => `${name} appears on manifest ${flightNumber} with matching travel document details.`,
      officerNoteTemplate: (name, airportName) => `Primary inspection for ${name} recorded at ${airportName} with complete itinerary details.`
    },
    ru: {
      residenceRole: "место проживания",
      workRole: "рабочий адрес",
      streetTypes: ["проспект", "улица", "дорога", "бульвар", "переулок"],
      districtWord: "район",
      tollBoothPrefix: "Пункт оплаты",
      airportWord: "Международный аэропорт",
      terminalWord: "Терминал",
      gateWord: "Выход",
      outbound: "выезд",
      inbound: "въезд",
      bidirectional: "двусторонний",
      paymentStatuses: ["зафиксирован", "оплачен", "сверен"],
      purposes: ["деловая поездка", "семейный визит", "конференция", "инспекция", "транзит"],
      visaStatuses: ["без визы", "возвращение резидента", "деловая виза", "дипломатическое разрешение"],
      inspectionResults: ["пропущен", "дополнительная проверка", "документы подтверждены"],
      titleTranslations: {
        "Senior Policy Analyst": "старший аналитик политики",
        "Deputy Director": "заместитель директора",
        "Research Coordinator": "координатор исследований",
        "Commercial Strategy Lead": "руководитель коммерческой стратегии",
        "Trade Compliance Officer": "специалист по торговому соответствию"
      },
      givenNames: ["Анна", "Илья", "Марина", "Олег", "Наталья", "Денис", "Елена", "Михаил", "София", "Павел"],
      familyNames: ["Иванов", "Петрова", "Соколова", "Морозов", "Кузнецова", "Волков", "Смирнова", "Орлов", "Лебедева", "Зайцев"],
      nameOrder: "given-family",
      nameJoiner: " ",
      streetBases: ["Портовый", "Литейный", "Речной", "Фонарный", "Каналовый", "Соборный", "Биржевой", "Рудный"],
      districtPrefixes: ["Центральный", "Северный", "Восточный", "Южный", "Западный"],
      cityRoots: ["Велорск", "Каменный Порт", "Озерный Берег", "Ясный Узел"],
      roadRoots: ["Портовая магистраль", "Минеральный маршрут", "Речная связка", "Городское кольцо", "Аэропортовая ветка", "Южный обход"],
      carrierRoots: ["Авиалинии Велории", "Маритон Интернешнл", "Синий Дугой Эйр", "Южно-Перешеечный Коннект"],
      organizationRoots: {
        government: ["Министерство торговой координации", "Бюро стратегического транзита", "Национальный секретариат пограничного контроля"],
        company: ["Северная гавань Логистика", "Городские грузовые системы", "Группа Горный Флот"],
        research: ["Институт прикладных транзитных исследований", "Обсерватория пограничной мобильности", "Центр маршрутного анализа"]
      },
      countryLabels: {
        "country-veloria": "Велория",
        "country-astriv": "Астрив",
        "country-demeris": "Демерис"
      },
      capitalLabels: {
        "country-veloria": "Маритон",
        "country-astriv": "Кераль",
        "country-demeris": "Сорет"
      },
      regionLabels: {
        "country-veloria": "Южный перешеек",
        "country-astriv": "Внутриконтинентальный пояс",
        "country-demeris": "Восточная морская дуга"
      },
      demonymLabels: {
        "country-veloria": "велориец",
        "country-astriv": "астривец",
        "country-demeris": "демериец"
      },
      driverNoteTemplate: (name, boothName) => `Метка автомобиля, связанного с ${name}, зафиксирована на пункте ${boothName}.`,
      manifestNoteTemplate: (name, flightNumber) => `${name} включен в манифест ${flightNumber} с совпадающими данными проездного документа.`,
      officerNoteTemplate: (name, airportName) => `Первичный контроль для ${name} зарегистрирован в ${airportName} с полным маршрутом.`
    },
    zh: {
      residenceRole: "住所",
      workRole: "工作地点",
      streetTypes: ["大道", "街", "路", "环路", "巷"],
      districtWord: "区",
      tollBoothPrefix: "收费站",
      airportWord: "国际机场",
      terminalWord: "航站楼",
      gateWord: "登机口",
      outbound: "出境",
      inbound: "入境",
      bidirectional: "双向",
      paymentStatuses: ["已采集", "已结算", "已对账"],
      purposes: ["公务", "探亲", "会议", "检查", "过境"],
      visaStatuses: ["免签", "居民返程", "商务签证", "外交许可"],
      inspectionResults: ["放行", "二次查验", "证件核验完成"],
      titleTranslations: {
        "Senior Policy Analyst": "高级政策分析员",
        "Deputy Director": "副主任",
        "Research Coordinator": "研究协调员",
        "Commercial Strategy Lead": "商业战略主管",
        "Trade Compliance Officer": "贸易合规专员"
      },
      givenNames: ["伟", "琳", "涛", "静", "晨", "洋", "芳", "浩", "宁", "悦"],
      familyNames: ["张", "李", "王", "陈", "林", "周", "刘", "黄", "吴", "赵"],
      nameOrder: "family-given",
      nameJoiner: "",
      streetBases: ["海岚", "工衡", "晨桥", "灯河", "松湾", "城策", "安渠", "星港"],
      districtPrefixes: ["中", "北", "东", "南", "西"],
      cityRoots: ["青岬", "北桥", "石港", "澜岸"],
      roadRoots: ["海港快线", "矿运通道", "河环联络", "城务环路", "机场支路", "南部绕行"],
      carrierRoots: ["维洛航空", "马里通国际航空", "蓝弧航空", "南峡连接航空"],
      organizationRoots: {
        government: ["贸易协调部", "战略通关局", "国家边检秘书处"],
        company: ["北港物流", "城策货运系统", "峰岭车队集团"],
        research: ["通行研究院", "边境流动观察所", "路线分析中心"]
      },
      countryLabels: {
        "country-veloria": "维罗利亚",
        "country-astriv": "阿斯特里夫",
        "country-demeris": "德梅里斯"
      },
      capitalLabels: {
        "country-veloria": "马里通",
        "country-astriv": "凯拉尔",
        "country-demeris": "索雷斯"
      },
      regionLabels: {
        "country-veloria": "南部地峡",
        "country-astriv": "内陆带",
        "country-demeris": "东部海弧"
      },
      demonymLabels: {
        "country-veloria": "维罗利亚人",
        "country-astriv": "阿斯特里夫人",
        "country-demeris": "德梅里斯人"
      },
      driverNoteTemplate: (name, boothName) => `在${boothName}采集到与${name}关联车辆的标签记录。`,
      manifestNoteTemplate: (name, flightNumber) => `${name} 出现在 ${flightNumber} 的舱单中，旅行证件信息一致。`,
      officerNoteTemplate: (name, airportName) => `${name} 在 ${airportName} 完成边检，行程信息完整。`
    },
    ar: {
      residenceRole: "عنوان السكن",
      workRole: "عنوان العمل",
      streetTypes: ["شارع", "طريق", "جادة", "بوليفارد", "ممر"],
      districtWord: "منطقة",
      tollBoothPrefix: "بوابة رسوم",
      airportWord: "مطار دولي",
      terminalWord: "مبنى",
      gateWord: "بوابة",
      outbound: "مغادرة",
      inbound: "وصول",
      bidirectional: "اتجاهان",
      paymentStatuses: ["تم الالتقاط", "تمت التسوية", "تمت المطابقة"],
      purposes: ["عمل", "زيارة عائلية", "مؤتمر", "تفتيش", "عبور"],
      visaStatuses: ["إعفاء من التأشيرة", "عودة مقيم", "تأشيرة عمل", "تصريح دبلوماسي"],
      inspectionResults: ["تم السماح", "مراجعة إضافية", "تم التحقق من الوثائق"],
      titleTranslations: {
        "Senior Policy Analyst": "محلل سياسات أول",
        "Deputy Director": "نائب المدير",
        "Research Coordinator": "منسق الأبحاث",
        "Commercial Strategy Lead": "قائد الاستراتيجية التجارية",
        "Trade Compliance Officer": "مسؤول الامتثال التجاري"
      },
      givenNames: ["ليلى", "عمر", "سارة", "يوسف", "نور", "كريم", "هالة", "آدم", "مريم", "سليم"],
      familyNames: ["المرزوق", "الشريف", "الحكيم", "القاسم", "الراشد", "الناصر", "التميمي", "السالم", "الحداد", "الخطيب"],
      nameOrder: "given-family",
      nameJoiner: " ",
      streetBases: ["الميناء", "الصناعة", "القناة", "المنارة", "السوق", "الجسر", "السهل", "المعدن"],
      districtPrefixes: ["الوسط", "الشمال", "الشرق", "الجنوب", "الغرب"],
      cityRoots: ["ميناء الحجر", "جسر الشمال", "ضفة البحيرة", "مفترق النور"],
      roadRoots: ["طريق الميناء السريع", "مسار المعادن", "وصلة النهر", "الحلقة المدنية", "وصلة المطار", "التحويلة الجنوبية"],
      carrierRoots: ["طيران فيلوريا", "ماريتون الدولية", "الطيران القوسي الأزرق", "ربط البرزخ الجنوبي"],
      organizationRoots: {
        government: ["وزارة تنسيق التجارة", "هيئة العبور الاستراتيجي", "الأمانة الوطنية للحدود"],
        company: ["لوجستيات الميناء الشمالي", "أنظمة الشحن المدنية", "مجموعة أسطول القمة"],
        research: ["معهد دراسات العبور التطبيقية", "مرصد الحركة الحدودية", "مركز تحليل المسارات"]
      },
      countryLabels: {
        "country-veloria": "فيلوريا",
        "country-astriv": "أستريف",
        "country-demeris": "ديميريس"
      },
      capitalLabels: {
        "country-veloria": "ماريتون",
        "country-astriv": "كيرال",
        "country-demeris": "سوريث"
      },
      regionLabels: {
        "country-veloria": "البرزخ الجنوبي",
        "country-astriv": "الحزام القاري الداخلي",
        "country-demeris": "القوس البحري الشرقي"
      },
      demonymLabels: {
        "country-veloria": "فيلوري",
        "country-astriv": "أستريفي",
        "country-demeris": "ديميريسي"
      },
      driverNoteTemplate: (name, boothName) => `تم رصد الوسم الخاص بمركبة مرتبطة بـ ${name} عند ${boothName}.`,
      manifestNoteTemplate: (name, flightNumber) => `${name} مدرج في بيان الرحلة ${flightNumber} مع تطابق بيانات الوثائق.`,
      officerNoteTemplate: (name, airportName) => `تم تسجيل الفحص الأولي لـ ${name} في ${airportName} مع تفاصيل رحلة مكتملة.`
    },
    es: {
      residenceRole: "residencia",
      workRole: "lugar de trabajo",
      streetTypes: ["Avenida", "Calle", "Camino", "Bulevar", "Pasaje"],
      districtWord: "Distrito",
      tollBoothPrefix: "Peaje",
      airportWord: "Aeropuerto Internacional",
      terminalWord: "Terminal",
      gateWord: "Puerta",
      outbound: "salida",
      inbound: "entrada",
      bidirectional: "bidireccional",
      paymentStatuses: ["capturado", "liquidado", "conciliado"],
      purposes: ["negocios", "visita familiar", "conferencia", "inspección", "tránsito"],
      visaStatuses: ["exención de visa", "retorno de residente", "visa de negocios", "autorización diplomática"],
      inspectionResults: ["autorizado", "revisión secundaria", "documentación verificada"],
      titleTranslations: {
        "Senior Policy Analyst": "analista sénior de políticas",
        "Deputy Director": "subdirector",
        "Research Coordinator": "coordinador de investigación",
        "Commercial Strategy Lead": "jefe de estrategia comercial",
        "Trade Compliance Officer": "oficial de cumplimiento comercial"
      },
      givenNames: ["Lucía", "Mateo", "Valeria", "Diego", "Sofía", "Andrés", "Camila", "Javier", "Elena", "Tomás"],
      familyNames: ["Morales", "Navarro", "Santos", "Rivas", "Paredes", "Cortés", "Mendoza", "Ibarra", "Solís", "Vega"],
      nameOrder: "given-family",
      nameJoiner: " ",
      streetBases: ["Puerto", "Cantera", "Mercado", "Luz", "Canal", "Cumbre", "Puente", "Aduana"],
      districtPrefixes: ["Centro", "Norte", "Este", "Sur", "Oeste"],
      cityRoots: ["Maritón", "Velora", "Puerto Piedra", "Puente Norte", "Ribera Clara", "Paso del Lago"],
      roadRoots: ["Corredor del Puerto", "Ruta Mineral", "Enlace del Río", "Anillo Cívico", "Ramal del Aeropuerto", "Desvío del Sur"],
      carrierRoots: ["Veloria Air", "Maritón Internacional", "Arco Azul Aéreo", "Conexión del Istmo Sur"],
      organizationRoots: {
        government: ["Ministerio de Coordinación Comercial", "Oficina de Tránsito Estratégico", "Secretaría Nacional de Fronteras"],
        company: ["Logística Puerto Norte", "Sistemas de Carga Cívica", "Grupo Flota Cumbre"],
        research: ["Instituto de Estudios de Tránsito Aplicado", "Observatorio de Movilidad Fronteriza", "Centro de Análisis de Rutas"]
      },
      countryLabels: {
        "country-veloria": "Veloria",
        "country-astriv": "Astriv",
        "country-demeris": "Demeris"
      },
      capitalLabels: {
        "country-veloria": "Maritón",
        "country-astriv": "Keral",
        "country-demeris": "Soret"
      },
      regionLabels: {
        "country-veloria": "Istmo del Sur",
        "country-astriv": "Cinturón Continental Interior",
        "country-demeris": "Arco Marítimo Oriental"
      },
      demonymLabels: {
        "country-veloria": "veloriano",
        "country-astriv": "astrivano",
        "country-demeris": "demeriano"
      },
      driverNoteTemplate: (name, boothName) => `Etiqueta observada en vehículo vinculado a ${name} en ${boothName}.`,
      manifestNoteTemplate: (name, flightNumber) => `${name} figura en el manifiesto ${flightNumber} con datos documentales coincidentes.`,
      officerNoteTemplate: (name, airportName) => `Control primario de ${name} registrado en ${airportName} con itinerario completo.`
    }
  };

  return profiles[locale];
}

function localizeCountryLabel(pack: ScenarioPack, profile: DataLanguageProfile): string {
  return profile.countryLabels[pack.country.id] ?? pack.country.name;
}

function localizeCapitalLabel(pack: ScenarioPack, profile: DataLanguageProfile): string {
  return profile.capitalLabels[pack.country.id] ?? pack.country.capital;
}

function localizeRegionLabel(pack: ScenarioPack, profile: DataLanguageProfile): string {
  return profile.regionLabels[pack.country.id] ?? pack.country.region;
}

function localizeDemonym(pack: ScenarioPack, profile: DataLanguageProfile): string {
  return profile.demonymLabels[pack.country.id] ?? pack.country.demonym;
}

function localizePersonName(person: Person, profile: DataLanguageProfile): string {
  const givenName = selectByKey(profile.givenNames, `${person.id}:given`);
  const familyName = selectByKey(profile.familyNames, `${person.id}:family`);
  if (profile.nameOrder === "family-given") {
    return `${familyName}${profile.nameJoiner}${givenName}`.trim();
  }

  return `${givenName}${profile.nameJoiner}${familyName}`.trim();
}

function localizeTitle(title: string, profile: DataLanguageProfile): string {
  return profile.titleTranslations[title] ?? title;
}

function localizeOrganizationName(organization: Organization, profile: DataLanguageProfile, countryLabel: string): string {
  const root = selectByKey(profile.organizationRoots[organization.kind], organization.id);
  return `${root} ${countryLabel}`.trim();
}

function createFictionalCities(profile: DataLanguageProfile, localizedCapital: string, localizedCountry: string): string[] {
  return [localizedCapital, localizedCountry, ...profile.cityRoots.slice(0, 4)];
}

function createAddresses(
  pack: ScenarioPack,
  faker: Faker,
  profilesByLanguage: Map<SupportedLocale, DataLanguageProfile>,
  organizationLanguages: Map<string, SupportedLocale>,
  localizedPersonNames: Map<string, string>,
  capitalsByLanguage: Map<SupportedLocale, string>,
  countriesByLanguage: Map<SupportedLocale, string>,
  regionsByLanguage: Map<SupportedLocale, string>,
  citiesByLanguage: Map<SupportedLocale, string[]>
): AddressRecord[] {
  const addresses: AddressRecord[] = [];

  for (const [index, person] of pack.people.entries()) {
    const personLanguage = getPersonLanguage(person, organizationLanguages, pack.dataLanguage);
    const profile = profilesByLanguage.get(personLanguage) ?? profilesByLanguage.get(pack.dataLanguage)!;
    const localizedCapital = capitalsByLanguage.get(personLanguage) ?? capitalsByLanguage.get(pack.dataLanguage) ?? pack.country.capital;
    const localizedCountry = countriesByLanguage.get(personLanguage) ?? countriesByLanguage.get(pack.dataLanguage) ?? pack.country.name;
    const localizedRegion = regionsByLanguage.get(personLanguage) ?? regionsByLanguage.get(pack.dataLanguage) ?? pack.country.region;
    const cities = citiesByLanguage.get(personLanguage) ?? citiesByLanguage.get(pack.dataLanguage) ?? [localizedCapital];

    for (const role of [profile.residenceRole, profile.workRole]) {
      const streetType = faker.helpers.arrayElement(profile.streetTypes);
      const streetBase = faker.helpers.arrayElement(profile.streetBases);
      const districtPrefix = faker.helpers.arrayElement(profile.districtPrefixes);
      const city = cities[(index + addresses.length) % cities.length] ?? localizedCapital;
      const buildingNumber = faker.number.int({ min: 11, max: 980 });
      const localizedName = localizedPersonNames.get(person.id) ?? person.fullName;

      addresses.push({
        addressId: `address-${person.id}-${role === profile.residenceRole ? "residence" : "work"}`,
        personId: person.id,
        dataLanguage: personLanguage,
        role,
        addressLine1: `${buildingNumber} ${streetBase} ${streetType}`,
        addressLine2: role === profile.workRole ? `${localizedCapital} ${localizedName}` : `${localizedCountry} Block ${index + 1}`,
        district: `${districtPrefix} ${profile.districtWord}`.trim(),
        city,
        region: localizedRegion,
        postalCode: faker.string.numeric({ length: 5, allowLeadingZeros: true }),
        latitude: createCoordinate(faker, 4, 18),
        longitude: createCoordinate(faker, 31, 48)
      });
    }
  }

  return addresses;
}

function createVehicles(
  pack: ScenarioPack,
  faker: Faker,
  addresses: AddressRecord[],
  organizationLanguages: Map<string, SupportedLocale>,
  localizedPersonNames: Map<string, string>,
  localizedCountry: string
): VehicleRecord[] {
  const vehicles: VehicleRecord[] = [];
  const scale = pack.generationProfile.csvScale;

  for (const person of pack.people) {
    const vehicleCount = scaledCount(faker, 1, 3, scale);
    const personAddresses = addresses.filter((address) => address.personId === person.id);
    const registeredAddress = personAddresses[0] ?? addresses[0];
    const ownerName = localizedPersonNames.get(person.id) ?? person.fullName;

    for (let index = 0; index < vehicleCount; index += 1) {
      const model = faker.helpers.arrayElement(vehicleCatalog);
      const issuedAt = faker.date.between({ from: "2021-01-01T00:00:00.000Z", to: "2024-12-31T00:00:00.000Z" }).toISOString();

      vehicles.push({
        vehicleId: `vehicle-${person.id}-${index + 1}`,
        ownerPersonId: person.id,
        primaryDriverPersonId: person.id,
        dataLanguage: getPersonLanguage(person, organizationLanguages, pack.dataLanguage),
        ownerName,
        make: model.make,
        model: model.model,
        modelYear: faker.number.int({ min: 2016, max: 2025 }),
        color: faker.helpers.arrayElement(operationalColors),
        vehicleType: model.type,
        tagNumber: `${localizedCountry.slice(0, 3).toUpperCase()}-${faker.string.alphanumeric({ casing: "upper", length: 6 })}`,
        registrationNumber: `${faker.string.alpha({ casing: "upper", length: 2 })}-${faker.string.numeric(4)}-${faker.string.alpha({ casing: "upper", length: 1 })}`,
        registeredAddressId: registeredAddress.addressId,
        registrationIssuedAt: issuedAt,
        activeFrom: issuedAt,
        activeTo: "active"
      });
    }
  }

  return vehicles;
}

function createTollBooths(
  faker: Faker,
  profile: DataLanguageProfile,
  dataLanguage: SupportedLocale,
  cities: string[],
  localizedRegion: string,
  scale: number
): TollBoothRecord[] {
  const boothCount = Math.max(6, scaleMinimum(6, scale));

  return Array.from({ length: boothCount }, (_, index) => {
    const roadName = profile.roadRoots[index % profile.roadRoots.length] ?? profile.roadRoots[0] ?? "Transit Corridor";
    const labeledRoadName = index < profile.roadRoots.length ? roadName : `${roadName} ${Math.floor(index / profile.roadRoots.length) + 1}`;

    return {
      boothId: `booth-${index + 1}`,
      dataLanguage,
      boothName: `${profile.tollBoothPrefix} ${index + 1}`,
      roadName: labeledRoadName,
      district: `${faker.helpers.arrayElement(profile.districtPrefixes)} ${profile.districtWord}`.trim(),
      city: cities[index % cities.length] ?? cities[0] ?? "",
      region: localizedRegion,
      latitude: createCoordinate(faker, 4, 18),
      longitude: createCoordinate(faker, 31, 48),
      lanes: faker.number.int({ min: 3, max: 8 }),
      directionServed: faker.helpers.arrayElement([profile.inbound, profile.outbound, profile.bidirectional])
    };
  });
}

function createTollTransactions(
  pack: ScenarioPack,
  faker: Faker,
  profile: DataLanguageProfile,
  vehicles: VehicleRecord[],
  booths: TollBoothRecord[]
): TollTransactionRecord[] {
  const currency = `${pack.country.name.slice(0, 3).toUpperCase()}D`;
  const scale = pack.generationProfile.csvScale;

  return vehicles.flatMap((vehicle) => {
    const transactionCount = scaledCount(faker, 28, 60, scale);
    return Array.from({ length: transactionCount }, (_, index) => {
      const booth = faker.helpers.arrayElement(booths);
      return {
        transactionId: `toll-${vehicle.vehicleId}-${index + 1}`,
        vehicleId: vehicle.vehicleId,
        ownerPersonId: vehicle.ownerPersonId,
        driverPersonId: vehicle.primaryDriverPersonId,
        dataLanguage: vehicle.dataLanguage,
        tagNumber: vehicle.tagNumber,
        boothId: booth.boothId,
        boothName: booth.boothName,
        transactedAt: faker.date.recent({ days: 140 }).toISOString(),
        tollAmountLocal: faker.number.float({ min: 2.5, max: 18.75, fractionDigits: 2 }).toFixed(2),
        currency,
        paymentStatus: faker.helpers.arrayElement(profile.paymentStatuses),
        laneId: `L-${faker.number.int({ min: 1, max: booth.lanes })}`,
        direction: faker.helpers.arrayElement([profile.inbound, profile.outbound]),
        plateCaptured: vehicle.registrationNumber,
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        driverNote: profile.driverNoteTemplate(vehicle.ownerName, booth.boothName)
      };
    });
  });
}

function createPassportNumber(faker: Faker): string {
  return `${faker.string.alpha({ casing: "upper", length: 2 })}${faker.string.numeric({ length: 7, allowLeadingZeros: true })}`;
}

function createAirportCode(countryName: string, faker: Faker): string {
  return `${countryName.slice(0, 2).toUpperCase()}${faker.string.alpha({ casing: "upper", length: 1 })}`;
}

function createBorderDatasets(
  pack: ScenarioPack,
  faker: Faker,
  profilesByLanguage: Map<SupportedLocale, DataLanguageProfile>,
  organizationLanguages: Map<string, SupportedLocale>,
  localizedPersonNames: Map<string, string>,
  capitalsByLanguage: Map<SupportedLocale, string>,
  demonymsByLanguage: Map<SupportedLocale, string>
): { borderCrossings: BorderCrossingRecord[]; manifests: FlightManifestRecord[] } {
  const realCountries = [
    { code: "CA", name: "Canada" },
    { code: "JP", name: "Japan" },
    { code: "DE", name: "Germany" },
    { code: "BR", name: "Brazil" },
    { code: "KE", name: "Kenya" },
    { code: "ES", name: "Spain" },
    { code: "AU", name: "Australia" }
  ];
  const borderCrossings: BorderCrossingRecord[] = [];
  const manifests: FlightManifestRecord[] = [];
  let manifestSequence = 1;
  const scale = pack.generationProfile.csvScale;
  const fictionalCountryCode = pack.country.name.slice(0, 2).toUpperCase();

  for (const person of pack.people) {
    const tripCount = scaledCount(faker, 2, 4, scale);
    const personLanguage = getPersonLanguage(person, organizationLanguages, pack.dataLanguage);
    const profile = profilesByLanguage.get(personLanguage) ?? profilesByLanguage.get(pack.dataLanguage)!;
    const localizedCapital = capitalsByLanguage.get(personLanguage) ?? capitalsByLanguage.get(pack.dataLanguage) ?? pack.country.capital;
    const localizedDemonym = demonymsByLanguage.get(personLanguage) ?? demonymsByLanguage.get(pack.dataLanguage) ?? pack.country.demonym;

    for (let tripIndex = 0; tripIndex < tripCount; tripIndex += 1) {
      const direction = faker.helpers.arrayElement([profile.inbound, profile.outbound]);
      const foreignCountry = faker.helpers.arrayElement(realCountries);
      const departureAt = faker.date.between({ from: "2024-01-01T00:00:00.000Z", to: "2025-12-31T00:00:00.000Z" });
      const arrivalAt = new Date(departureAt.getTime() + faker.number.int({ min: 2, max: 12 }) * 60 * 60 * 1000);
      const trip: ManifestTrip = {
        manifestId: `manifest-${person.id}-${tripIndex + 1}`,
        travelDirection: direction,
        airportCode: createAirportCode(pack.country.name, faker),
        airportName: `${localizedCapital} ${profile.airportWord}`,
        flightNumber: `VA${faker.string.numeric({ length: 3, allowLeadingZeros: true })}`,
        carrierName: selectByKey(profile.carrierRoots, `${person.id}:carrier:${tripIndex}`),
        originCountryCode: direction === profile.outbound ? fictionalCountryCode : foreignCountry.code,
        originCountryName: direction === profile.outbound ? pack.country.name : foreignCountry.name,
        destinationCountryCode: direction === profile.outbound ? foreignCountry.code : fictionalCountryCode,
        destinationCountryName: direction === profile.outbound ? foreignCountry.name : pack.country.name,
        departureAt: departureAt.toISOString(),
        arrivalAt: arrivalAt.toISOString(),
        terminal: `${profile.terminalWord} ${faker.number.int({ min: 1, max: 3 })}`,
        gate: `${profile.gateWord} ${faker.string.alpha({ casing: "upper", length: 1 })}${faker.number.int({ min: 1, max: 29 })}`
      };

      const maxTravelPartySize = Math.min(Math.max(3, scaleMinimum(3, scale)), pack.people.length);
      const travelParty = faker.helpers.arrayElements(pack.people, { min: 1, max: maxTravelPartySize });
      if (!travelParty.some((candidate) => candidate.id === person.id)) {
        travelParty[0] = person;
      }

      for (const traveler of travelParty) {
        const travelerLanguage = getPersonLanguage(traveler, organizationLanguages, pack.dataLanguage);
        const travelerProfile = profilesByLanguage.get(travelerLanguage) ?? profile;
        const travelerCapital = capitalsByLanguage.get(travelerLanguage) ?? localizedCapital;
        const travelerDemonym = demonymsByLanguage.get(travelerLanguage) ?? localizedDemonym;
        const travelerName = localizedPersonNames.get(traveler.id) ?? traveler.fullName;
        const passportNumber = createPassportNumber(faker);
        const baggageCount = scaledCount(faker, 0, 3, Math.max(1, Math.min(scale, 3)));
        const seatNumber = `${faker.number.int({ min: 3, max: 28 })}${faker.string.alpha({ casing: "upper", length: 1 })}`;

        manifests.push({
          manifestId: trip.manifestId,
          manifestSequence,
          dataLanguage: travelerLanguage,
          flightNumber: trip.flightNumber,
          carrierName: trip.carrierName,
          travelDirection: trip.travelDirection,
          airportCode: trip.airportCode,
          originCountryCode: trip.originCountryCode,
          originCountryName: trip.originCountryName,
          destinationCountryCode: trip.destinationCountryCode,
          destinationCountryName: trip.destinationCountryName,
          departureAt: trip.departureAt,
          arrivalAt: trip.arrivalAt,
          travelerPersonId: traveler.id,
          travelerName,
          passportNumber,
          nationality: travelerDemonym,
          seatNumber,
          checkedBagCount: baggageCount,
          boardingZone: `Zone ${faker.number.int({ min: 1, max: 5 })}`,
          manifestNote: travelerProfile.manifestNoteTemplate(travelerName, trip.flightNumber)
        });

        borderCrossings.push({
          crossingId: `crossing-${trip.manifestId}-${traveler.id}`,
          manifestId: trip.manifestId,
          travelerPersonId: traveler.id,
          dataLanguage: travelerLanguage,
          travelerName,
          passportNumber,
          passportCountryCode: pack.country.name.slice(0, 2).toUpperCase(),
          nationality: travelerDemonym,
          crossingDirection: trip.travelDirection,
          airportCode: trip.airportCode,
          airportName: `${travelerCapital} ${travelerProfile.airportWord}`,
          flightNumber: trip.flightNumber,
          carrierName: trip.carrierName,
          originCountryCode: trip.originCountryCode,
          originCountryName: trip.originCountryName,
          destinationCountryCode: trip.destinationCountryCode,
          destinationCountryName: trip.destinationCountryName,
          scheduledDepartureAt: trip.departureAt,
          scheduledArrivalAt: trip.arrivalAt,
          recordedAt: new Date(arrivalAt.getTime() + faker.number.int({ min: 5, max: 90 }) * 60 * 1000).toISOString(),
          terminal: trip.terminal,
          gate: trip.gate,
          seatNumber,
          baggageCount,
          travelPurpose: faker.helpers.arrayElement(travelerProfile.purposes),
          visaStatus: faker.helpers.arrayElement(travelerProfile.visaStatuses),
          inspectionResult: faker.helpers.arrayElement(travelerProfile.inspectionResults),
          officerNote: travelerProfile.officerNoteTemplate(travelerName, `${travelerCapital} ${travelerProfile.airportWord}`)
        });
      }

      manifestSequence += 1;
    }
  }

  return { borderCrossings, manifests };
}

function createTravelBookings(
  faker: Faker,
  manifests: FlightManifestRecord[],
  profilesByLanguage: Map<SupportedLocale, DataLanguageProfile>
): TravelBookingRecord[] {
  return manifests.map((manifest, index) => {
    const profile = profilesByLanguage.get(manifest.dataLanguage) ?? profilesByLanguage.values().next().value;
    const departureAt = new Date(manifest.departureAt);
    const bookedAt = new Date(departureAt.getTime() - faker.number.int({ min: 2, max: 28 }) * 24 * 60 * 60 * 1000);

    return {
      bookingId: `booking-${manifest.manifestId}-${manifest.travelerPersonId}`,
      manifestId: manifest.manifestId,
      travelerPersonId: manifest.travelerPersonId,
      dataLanguage: manifest.dataLanguage,
      travelerName: manifest.travelerName,
      bookingReference: `${faker.string.alpha({ casing: "upper", length: 3 })}${faker.string.alphanumeric({ casing: "upper", length: 5 })}`,
      bookingChannel: faker.helpers.arrayElement(bookingChannels),
      bookingStatus: faker.helpers.arrayElement(bookingStatuses),
      bookedAt: bookedAt.toISOString(),
      flightNumber: manifest.flightNumber,
      carrierName: manifest.carrierName,
      originCountryCode: manifest.originCountryCode,
      originCountryName: manifest.originCountryName,
      destinationCountryCode: manifest.destinationCountryCode,
      destinationCountryName: manifest.destinationCountryName,
      departureAt: manifest.departureAt,
      arrivalAt: manifest.arrivalAt,
      fareClass: fareClasses[index % fareClasses.length] ?? fareClasses[0],
      tripPurpose: faker.helpers.arrayElement(profile?.purposes ?? ["business review"])
    };
  });
}

function createHotelStays(
  faker: Faker,
  manifests: FlightManifestRecord[],
  profilesByLanguage: Map<SupportedLocale, DataLanguageProfile>
): HotelStayRecord[] {
  return manifests.flatMap((manifest, index) => {
    const profile = profilesByLanguage.get(manifest.dataLanguage) ?? profilesByLanguage.values().next().value;
    if (manifest.travelDirection !== profile?.outbound) {
      return [];
    }

    const arrivalAt = new Date(manifest.arrivalAt);
    const checkInAt = new Date(arrivalAt.getTime() + faker.number.int({ min: 1, max: 4 }) * 60 * 60 * 1000);
    const stayLengthDays = faker.number.int({ min: 2, max: 8 });
    const checkOutAt = new Date(checkInAt.getTime() + stayLengthDays * 24 * 60 * 60 * 1000);
    const city = `${manifest.destinationCountryName} ${index % 2 === 0 ? "Central" : "Harbor"}`;

    return [{
      stayId: `stay-${manifest.manifestId}-${manifest.travelerPersonId}`,
      manifestId: manifest.manifestId,
      travelerPersonId: manifest.travelerPersonId,
      dataLanguage: manifest.dataLanguage,
      travelerName: manifest.travelerName,
      hotelName: `${city} ${index % 3 === 0 ? "Grand Hotel" : index % 3 === 1 ? "Business Lodge" : "Civic Suites"}`,
      city,
      countryCode: manifest.destinationCountryCode,
      countryName: manifest.destinationCountryName,
      checkInAt: checkInAt.toISOString(),
      checkOutAt: checkOutAt.toISOString(),
      roomType: hotelRoomTypes[index % hotelRoomTypes.length] ?? hotelRoomTypes[0],
      bookingStatus: "confirmed",
      paymentStatus: hotelPaymentStatuses[index % hotelPaymentStatuses.length] ?? hotelPaymentStatuses[0],
      nightlyRateLocal: faker.number.float({ min: 95, max: 310, fractionDigits: 2 }).toFixed(2),
      currency: "USD",
      stayPurpose: faker.helpers.arrayElement(profile?.purposes ?? ["business review"])
    }];
  });
}

function createPersonMentions(
  pack: ScenarioPack,
  localizedPersonNames: Map<string, string>,
  vehicles: VehicleRecord[],
  tollTransactions: TollTransactionRecord[],
  borderCrossings: BorderCrossingRecord[]
): PersonMentionRecord[] {
  const mentions: PersonMentionRecord[] = [];

  for (const report of pack.reports) {
    const author = pack.people.find((person) => person.id === report.authorPersonId);
    if (author) {
      const personName = localizedPersonNames.get(author.id) ?? author.fullName;
      mentions.push({
        mentionId: `mention-report-author-${report.id}`,
        personId: author.id,
        personName,
        sourceTable: "reports",
        sourceRecordId: report.id,
        mentionField: "author_person_id",
        mentionedValue: personName,
        dataLanguage: pack.dataLanguage
      });
    }
  }

  for (const email of pack.emails) {
    for (const personId of [email.fromPersonId, ...email.toPersonIds, ...email.ccPersonIds]) {
      const person = pack.people.find((candidate) => candidate.id === personId);
      if (!person) {
        continue;
      }

      const personName = localizedPersonNames.get(person.id) ?? person.fullName;
      mentions.push({
        mentionId: `mention-email-${email.id}-${person.id}`,
        personId: person.id,
        personName,
        sourceTable: "emails",
        sourceRecordId: email.id,
        mentionField: "participant",
        mentionedValue: personName,
        dataLanguage: pack.dataLanguage
      });
    }
  }

  for (const vehicle of vehicles) {
    mentions.push({
      mentionId: `mention-vehicle-${vehicle.vehicleId}`,
      personId: vehicle.ownerPersonId,
      personName: vehicle.ownerName,
      sourceTable: "vehicles",
      sourceRecordId: vehicle.vehicleId,
      mentionField: "owner_name",
      mentionedValue: vehicle.ownerName,
      dataLanguage: pack.dataLanguage
    });
  }

  for (const transaction of tollTransactions.slice(0, Math.min(120, tollTransactions.length))) {
    const personName = localizedPersonNames.get(transaction.ownerPersonId);
    if (!personName) {
      continue;
    }

    mentions.push({
      mentionId: `mention-toll-${transaction.transactionId}`,
      personId: transaction.ownerPersonId,
      personName,
      sourceTable: "toll_transactions",
      sourceRecordId: transaction.transactionId,
      mentionField: "driver_note",
      mentionedValue: transaction.driverNote,
      dataLanguage: pack.dataLanguage
    });
  }

  for (const crossing of borderCrossings) {
    mentions.push({
      mentionId: `mention-border-${crossing.crossingId}`,
      personId: crossing.travelerPersonId,
      personName: crossing.travelerName,
      sourceTable: "border_crossings",
      sourceRecordId: crossing.crossingId,
      mentionField: "officer_note",
      mentionedValue: crossing.officerNote,
      dataLanguage: pack.dataLanguage
    });
  }

  return mentions;
}

function createPeopleDirectoryRows(
  pack: ScenarioPack,
  profilesByLanguage: Map<SupportedLocale, DataLanguageProfile>,
  organizationLanguages: Map<string, SupportedLocale>,
  localizedPersonNames: Map<string, string>,
  localizedOrganizationNames: Map<string, string>,
  addresses: AddressRecord[],
  mentions: PersonMentionRecord[],
  countriesByLanguage: Map<SupportedLocale, string>
): Array<Array<string | number>> {
  return pack.people.map((person) => {
    const personLanguage = getPersonLanguage(person, organizationLanguages, pack.dataLanguage);
    const profile = profilesByLanguage.get(personLanguage) ?? profilesByLanguage.get(pack.dataLanguage)!;
    const localizedCountry = countriesByLanguage.get(personLanguage) ?? countriesByLanguage.get(pack.dataLanguage) ?? pack.country.name;
    const personAddresses = addresses.filter((address) => address.personId === person.id);
    const residence = personAddresses[0];
    const worksite = personAddresses[1];
    const mentionCount = mentions.filter((mention) => mention.personId === person.id).length;

    return [
      person.id,
      personLanguage,
      localizedPersonNames.get(person.id) ?? person.fullName,
      localizeTitle(person.title, profile),
      person.organizationId,
      localizedOrganizationNames.get(person.organizationId) ?? person.organizationId,
      person.email,
      residence?.addressId ?? "",
      worksite?.addressId ?? "",
      residence?.city ?? "",
      residence?.region ?? "",
      localizedCountry,
      mentionCount
    ];
  });
}

function getAllEntityIds(pack: ScenarioPack): string[] {
  return [
    pack.country.id,
    ...pack.organizations.map((organization) => organization.id),
    ...pack.people.map((person) => person.id),
    ...pack.reports.map((report) => report.id),
    ...pack.emails.map((email) => email.id),
    ...pack.events.map((event) => event.id)
  ];
}

function buildStandardCsvDatasets(pack: ScenarioPack): CsvDataset[] {
  return [
    {
      relativePath: "exports/reports.csv",
      description: "Normalized report export",
      sourceEntityIds: pack.reports.map((report) => report.id),
      adxTableName: "Reports",
      adxColumns: [
        { name: "report_id", type: "string" },
        { name: "title", type: "string" },
        { name: "kind", type: "string" },
        { name: "organization_id", type: "string" },
        { name: "author_person_id", type: "string" },
        { name: "created_at", type: "datetime" },
        { name: "tags", type: "string" }
      ],
      header: ["report_id", "title", "kind", "organization_id", "author_person_id", "created_at", "tags"],
      rows: pack.reports.map((report) => [
        report.id,
        report.title,
        report.kind,
        report.organizationId,
        report.authorPersonId,
        report.createdAt,
        report.subjectTags.join("|")
      ])
    },
    {
      relativePath: "exports/emails.csv",
      description: "Normalized email export",
      sourceEntityIds: pack.emails.map((email) => email.id),
      adxTableName: "Emails",
      adxColumns: [
        { name: "email_id", type: "string" },
        { name: "thread_id", type: "string" },
        { name: "subject", type: "string" },
        { name: "from_person_id", type: "string" },
        { name: "to_person_ids", type: "string" },
        { name: "sent_at", type: "datetime" },
        { name: "related_document_ids", type: "string" }
      ],
      header: ["email_id", "thread_id", "subject", "from_person_id", "to_person_ids", "sent_at", "related_document_ids"],
      rows: pack.emails.map((email) => [
        email.id,
        email.threadId,
        email.subject,
        email.fromPersonId,
        email.toPersonIds.join("|"),
        email.sentAt,
        email.relatedDocumentIds.join("|")
      ])
    }
  ];
}

function buildOperationalCsvDatasets(pack: ScenarioPack): CsvDataset[] {
  const faker = createFaker(pack.seed * 101 + 17);
  const organizationLanguages = createOrganizationLanguageMap(pack);
  const activeLanguages = new Set<SupportedLocale>([pack.dataLanguage, ...organizationLanguages.values()]);
  const profilesByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, getDataLanguageProfile(language)]));
  const countriesByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, localizeCountryLabel(pack, profilesByLanguage.get(language)!)]));
  const capitalsByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, localizeCapitalLabel(pack, profilesByLanguage.get(language)!)]));
  const regionsByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, localizeRegionLabel(pack, profilesByLanguage.get(language)!)]));
  const demonymsByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, localizeDemonym(pack, profilesByLanguage.get(language)!)]));
  const citiesByLanguage = new Map(Array.from(activeLanguages).map((language) => [language, createFictionalCities(profilesByLanguage.get(language)!, capitalsByLanguage.get(language)!, countriesByLanguage.get(language)!)]));
  const localizedPersonNames = new Map(pack.people.map((person) => {
    const personLanguage = getPersonLanguage(person, organizationLanguages, pack.dataLanguage);
    return [person.id, localizePersonName(person, profilesByLanguage.get(personLanguage) ?? profilesByLanguage.get(pack.dataLanguage)!)] as const;
  }));
  const localizedOrganizationNames = new Map(pack.organizations.map((organization) => {
    const organizationLanguage = organizationLanguages.get(organization.id) ?? pack.dataLanguage;
    return [organization.id, localizeOrganizationName(organization, profilesByLanguage.get(organizationLanguage) ?? profilesByLanguage.get(pack.dataLanguage)!, countriesByLanguage.get(organizationLanguage) ?? countriesByLanguage.get(pack.dataLanguage)!)] as const;
  }));
  const defaultProfile = profilesByLanguage.get(pack.dataLanguage)!;
  const defaultCountry = countriesByLanguage.get(pack.dataLanguage)!;
  const defaultRegion = regionsByLanguage.get(pack.dataLanguage)!;
  const defaultCities = citiesByLanguage.get(pack.dataLanguage)!;
  const addresses = createAddresses(pack, faker, profilesByLanguage, organizationLanguages, localizedPersonNames, capitalsByLanguage, countriesByLanguage, regionsByLanguage, citiesByLanguage);
  const vehicles = createVehicles(pack, faker, addresses, organizationLanguages, localizedPersonNames, defaultCountry);
  const tollBooths = createTollBooths(
    faker,
    defaultProfile,
    pack.dataLanguage,
    defaultCities,
    defaultRegion,
    pack.generationProfile.csvScale
  );
  const tollTransactions = createTollTransactions(pack, faker, defaultProfile, vehicles, tollBooths);
  const { borderCrossings, manifests } = createBorderDatasets(pack, faker, profilesByLanguage, organizationLanguages, localizedPersonNames, capitalsByLanguage, demonymsByLanguage);
  const travelBookings = createTravelBookings(faker, manifests, profilesByLanguage);
  const hotelStays = createHotelStays(faker, manifests, profilesByLanguage);
  const mentions = createPersonMentions(pack, localizedPersonNames, vehicles, tollTransactions, borderCrossings);
  const peopleDirectoryRows = createPeopleDirectoryRows(pack, profilesByLanguage, organizationLanguages, localizedPersonNames, localizedOrganizationNames, addresses, mentions, countriesByLanguage);
  const sharedSourceEntityIds = [pack.country.id, ...pack.people.map((person) => person.id)];

  return [
    {
      relativePath: "exports/people-directory.csv",
      description: "Localized people directory export with address linkage and mention counts",
      sourceEntityIds: pack.people.map((person) => person.id),
      adxTableName: "PeopleDirectory",
      adxColumns: [
        { name: "person_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "full_name", type: "string" },
        { name: "title", type: "string" },
        { name: "organization_id", type: "string" },
        { name: "organization_name", type: "string" },
        { name: "email", type: "string" },
        { name: "primary_address_id", type: "string" },
        { name: "work_address_id", type: "string" },
        { name: "city", type: "string" },
        { name: "region", type: "string" },
        { name: "country_name", type: "string" },
        { name: "mentioned_record_count", type: "int" }
      ],
      header: [
        "person_id",
        "data_language",
        "full_name",
        "title",
        "organization_id",
        "organization_name",
        "email",
        "primary_address_id",
        "work_address_id",
        "city",
        "region",
        "country_name",
        "mentioned_record_count"
      ],
      rows: peopleDirectoryRows
    },
    {
      relativePath: "exports/addresses.csv",
      description: "Localized fictional address export linked to people records",
      sourceEntityIds: pack.people.map((person) => person.id),
      adxTableName: "Addresses",
      adxColumns: [
        { name: "address_id", type: "string" },
        { name: "person_id", type: "string" },
        { name: "address_role", type: "string" },
        { name: "data_language", type: "string" },
        { name: "address_line1", type: "string" },
        { name: "address_line2", type: "string" },
        { name: "district", type: "string" },
        { name: "city", type: "string" },
        { name: "region", type: "string" },
        { name: "postal_code", type: "string" },
        { name: "country_name", type: "string" },
        { name: "latitude", type: "real" },
        { name: "longitude", type: "real" }
      ],
      header: [
        "address_id",
        "person_id",
        "address_role",
        "data_language",
        "address_line1",
        "address_line2",
        "district",
        "city",
        "region",
        "postal_code",
        "country_name",
        "latitude",
        "longitude"
      ],
      rows: addresses.map((address) => [
        address.addressId,
        address.personId,
        address.role,
        address.dataLanguage,
        address.addressLine1,
        address.addressLine2,
        address.district,
        address.city,
        address.region,
        address.postalCode,
        countriesByLanguage.get(address.dataLanguage) ?? defaultCountry,
        address.latitude,
        address.longitude
      ])
    },
    {
      relativePath: "exports/vehicles.csv",
      description: "Vehicle registration export keyed by person owners and address records",
      sourceEntityIds: pack.people.map((person) => person.id),
      adxTableName: "Vehicles",
      adxColumns: [
        { name: "vehicle_id", type: "string" },
        { name: "owner_person_id", type: "string" },
        { name: "primary_driver_person_id", type: "string" },
        { name: "owner_name", type: "string" },
        { name: "data_language", type: "string" },
        { name: "make", type: "string" },
        { name: "model", type: "string" },
        { name: "model_year", type: "int" },
        { name: "color", type: "string" },
        { name: "vehicle_type", type: "string" },
        { name: "tag_number", type: "string" },
        { name: "registration_number", type: "string" },
        { name: "registered_address_id", type: "string" },
        { name: "registration_issued_at", type: "datetime" },
        { name: "active_from", type: "datetime" },
        { name: "active_to", type: "string" }
      ],
      header: [
        "vehicle_id",
        "owner_person_id",
        "primary_driver_person_id",
        "owner_name",
        "data_language",
        "make",
        "model",
        "model_year",
        "color",
        "vehicle_type",
        "tag_number",
        "registration_number",
        "registered_address_id",
        "registration_issued_at",
        "active_from",
        "active_to"
      ],
      rows: vehicles.map((vehicle) => [
        vehicle.vehicleId,
        vehicle.ownerPersonId,
        vehicle.primaryDriverPersonId,
        vehicle.ownerName,
        vehicle.dataLanguage,
        vehicle.make,
        vehicle.model,
        vehicle.modelYear,
        vehicle.color,
        vehicle.vehicleType,
        vehicle.tagNumber,
        vehicle.registrationNumber,
        vehicle.registeredAddressId,
        vehicle.registrationIssuedAt,
        vehicle.activeFrom,
        vehicle.activeTo
      ])
    },
    {
      relativePath: "exports/toll-booths.csv",
      description: "Fictional toll booth reference data for the generated country road network",
      sourceEntityIds: [pack.country.id],
      adxTableName: "TollBooths",
      adxColumns: [
        { name: "booth_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "booth_name", type: "string" },
        { name: "road_name", type: "string" },
        { name: "district", type: "string" },
        { name: "city", type: "string" },
        { name: "region", type: "string" },
        { name: "latitude", type: "real" },
        { name: "longitude", type: "real" },
        { name: "lanes", type: "int" },
        { name: "direction_served", type: "string" }
      ],
      header: [
        "booth_id",
        "data_language",
        "booth_name",
        "road_name",
        "district",
        "city",
        "region",
        "latitude",
        "longitude",
        "lanes",
        "direction_served"
      ],
      rows: tollBooths.map((booth) => [
        booth.boothId,
        booth.dataLanguage,
        booth.boothName,
        booth.roadName,
        booth.district,
        booth.city,
        booth.region,
        booth.latitude,
        booth.longitude,
        booth.lanes,
        booth.directionServed
      ])
    },
    {
      relativePath: "exports/toll-transactions.csv",
      description: "High-volume toll transaction export linked to vehicles, tags, and owners",
      sourceEntityIds: sharedSourceEntityIds,
      adxTableName: "TollTransactions",
      adxColumns: [
        { name: "transaction_id", type: "string" },
        { name: "vehicle_id", type: "string" },
        { name: "owner_person_id", type: "string" },
        { name: "driver_person_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "tag_number", type: "string" },
        { name: "booth_id", type: "string" },
        { name: "booth_name", type: "string" },
        { name: "transacted_at", type: "datetime" },
        { name: "toll_amount_local", type: "real" },
        { name: "currency", type: "string" },
        { name: "payment_status", type: "string" },
        { name: "lane_id", type: "string" },
        { name: "direction", type: "string" },
        { name: "plate_captured", type: "string" },
        { name: "vehicle_make", type: "string" },
        { name: "vehicle_model", type: "string" },
        { name: "driver_note", type: "string" }
      ],
      header: [
        "transaction_id",
        "vehicle_id",
        "owner_person_id",
        "driver_person_id",
        "data_language",
        "tag_number",
        "booth_id",
        "booth_name",
        "transacted_at",
        "toll_amount_local",
        "currency",
        "payment_status",
        "lane_id",
        "direction",
        "plate_captured",
        "vehicle_make",
        "vehicle_model",
        "driver_note"
      ],
      rows: tollTransactions.map((transaction) => [
        transaction.transactionId,
        transaction.vehicleId,
        transaction.ownerPersonId,
        transaction.driverPersonId,
        transaction.dataLanguage,
        transaction.tagNumber,
        transaction.boothId,
        transaction.boothName,
        transaction.transactedAt,
        transaction.tollAmountLocal,
        transaction.currency,
        transaction.paymentStatus,
        transaction.laneId,
        transaction.direction,
        transaction.plateCaptured,
        transaction.vehicleMake,
        transaction.vehicleModel,
        transaction.driverNote
      ])
    },
    {
      relativePath: "exports/border-crossings.csv",
      description: "Airport border crossing export with travel document and inspection fields",
      sourceEntityIds: sharedSourceEntityIds,
      adxTableName: "BorderCrossings",
      adxColumns: [
        { name: "crossing_id", type: "string" },
        { name: "manifest_id", type: "string" },
        { name: "traveler_person_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "traveler_name", type: "string" },
        { name: "passport_number", type: "string" },
        { name: "passport_country_code", type: "string" },
        { name: "nationality", type: "string" },
        { name: "crossing_direction", type: "string" },
        { name: "airport_code", type: "string" },
        { name: "airport_name", type: "string" },
        { name: "flight_number", type: "string" },
        { name: "carrier_name", type: "string" },
        { name: "origin_country_code", type: "string" },
        { name: "origin_country_name", type: "string" },
        { name: "destination_country_code", type: "string" },
        { name: "destination_country_name", type: "string" },
        { name: "scheduled_departure_at", type: "datetime" },
        { name: "scheduled_arrival_at", type: "datetime" },
        { name: "recorded_at", type: "datetime" },
        { name: "terminal", type: "string" },
        { name: "gate", type: "string" },
        { name: "seat_number", type: "string" },
        { name: "baggage_count", type: "int" },
        { name: "travel_purpose", type: "string" },
        { name: "visa_status", type: "string" },
        { name: "inspection_result", type: "string" },
        { name: "officer_note", type: "string" }
      ],
      header: [
        "crossing_id",
        "manifest_id",
        "traveler_person_id",
        "data_language",
        "traveler_name",
        "passport_number",
        "passport_country_code",
        "nationality",
        "crossing_direction",
        "airport_code",
        "airport_name",
        "flight_number",
        "carrier_name",
        "origin_country_code",
        "origin_country_name",
        "destination_country_code",
        "destination_country_name",
        "scheduled_departure_at",
        "scheduled_arrival_at",
        "recorded_at",
        "terminal",
        "gate",
        "seat_number",
        "baggage_count",
        "travel_purpose",
        "visa_status",
        "inspection_result",
        "officer_note"
      ],
      rows: borderCrossings.map((crossing) => [
        crossing.crossingId,
        crossing.manifestId,
        crossing.travelerPersonId,
        crossing.dataLanguage,
        crossing.travelerName,
        crossing.passportNumber,
        crossing.passportCountryCode,
        crossing.nationality,
        crossing.crossingDirection,
        crossing.airportCode,
        crossing.airportName,
        crossing.flightNumber,
        crossing.carrierName,
        crossing.originCountryCode,
        crossing.originCountryName,
        crossing.destinationCountryCode,
        crossing.destinationCountryName,
        crossing.scheduledDepartureAt,
        crossing.scheduledArrivalAt,
        crossing.recordedAt,
        crossing.terminal,
        crossing.gate,
        crossing.seatNumber,
        crossing.baggageCount,
        crossing.travelPurpose,
        crossing.visaStatus,
        crossing.inspectionResult,
        crossing.officerNote
      ])
    },
    {
      relativePath: "exports/flight-manifests.csv",
      description: "Flight manifest rows aligned to airport border crossing events",
      sourceEntityIds: sharedSourceEntityIds,
      adxTableName: "FlightManifests",
      adxColumns: [
        { name: "manifest_id", type: "string" },
        { name: "manifest_sequence", type: "int" },
        { name: "data_language", type: "string" },
        { name: "flight_number", type: "string" },
        { name: "carrier_name", type: "string" },
        { name: "travel_direction", type: "string" },
        { name: "airport_code", type: "string" },
        { name: "origin_country_code", type: "string" },
        { name: "origin_country_name", type: "string" },
        { name: "destination_country_code", type: "string" },
        { name: "destination_country_name", type: "string" },
        { name: "departure_at", type: "datetime" },
        { name: "arrival_at", type: "datetime" },
        { name: "traveler_person_id", type: "string" },
        { name: "traveler_name", type: "string" },
        { name: "passport_number", type: "string" },
        { name: "nationality", type: "string" },
        { name: "seat_number", type: "string" },
        { name: "checked_bag_count", type: "int" },
        { name: "boarding_zone", type: "string" },
        { name: "manifest_note", type: "string" }
      ],
      header: [
        "manifest_id",
        "manifest_sequence",
        "data_language",
        "flight_number",
        "carrier_name",
        "travel_direction",
        "airport_code",
        "origin_country_code",
        "origin_country_name",
        "destination_country_code",
        "destination_country_name",
        "departure_at",
        "arrival_at",
        "traveler_person_id",
        "traveler_name",
        "passport_number",
        "nationality",
        "seat_number",
        "checked_bag_count",
        "boarding_zone",
        "manifest_note"
      ],
      rows: manifests.map((manifest) => [
        manifest.manifestId,
        manifest.manifestSequence,
        manifest.dataLanguage,
        manifest.flightNumber,
        manifest.carrierName,
        manifest.travelDirection,
        manifest.airportCode,
        manifest.originCountryCode,
        manifest.originCountryName,
        manifest.destinationCountryCode,
        manifest.destinationCountryName,
        manifest.departureAt,
        manifest.arrivalAt,
        manifest.travelerPersonId,
        manifest.travelerName,
        manifest.passportNumber,
        manifest.nationality,
        manifest.seatNumber,
        manifest.checkedBagCount,
        manifest.boardingZone,
        manifest.manifestNote
      ])
    },
    {
      relativePath: "exports/travel-bookings.csv",
      description: "Travel booking export aligned to generated air travel records",
      sourceEntityIds: sharedSourceEntityIds,
      adxTableName: "TravelBookings",
      adxColumns: [
        { name: "booking_id", type: "string" },
        { name: "manifest_id", type: "string" },
        { name: "traveler_person_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "traveler_name", type: "string" },
        { name: "booking_reference", type: "string" },
        { name: "booking_channel", type: "string" },
        { name: "booking_status", type: "string" },
        { name: "booked_at", type: "datetime" },
        { name: "flight_number", type: "string" },
        { name: "carrier_name", type: "string" },
        { name: "origin_country_code", type: "string" },
        { name: "origin_country_name", type: "string" },
        { name: "destination_country_code", type: "string" },
        { name: "destination_country_name", type: "string" },
        { name: "departure_at", type: "datetime" },
        { name: "arrival_at", type: "datetime" },
        { name: "fare_class", type: "string" },
        { name: "trip_purpose", type: "string" }
      ],
      header: [
        "booking_id",
        "manifest_id",
        "traveler_person_id",
        "data_language",
        "traveler_name",
        "booking_reference",
        "booking_channel",
        "booking_status",
        "booked_at",
        "flight_number",
        "carrier_name",
        "origin_country_code",
        "origin_country_name",
        "destination_country_code",
        "destination_country_name",
        "departure_at",
        "arrival_at",
        "fare_class",
        "trip_purpose"
      ],
      rows: travelBookings.map((booking) => [
        booking.bookingId,
        booking.manifestId,
        booking.travelerPersonId,
        booking.dataLanguage,
        booking.travelerName,
        booking.bookingReference,
        booking.bookingChannel,
        booking.bookingStatus,
        booking.bookedAt,
        booking.flightNumber,
        booking.carrierName,
        booking.originCountryCode,
        booking.originCountryName,
        booking.destinationCountryCode,
        booking.destinationCountryName,
        booking.departureAt,
        booking.arrivalAt,
        booking.fareClass,
        booking.tripPurpose
      ])
    },
    {
      relativePath: "exports/hotel-stays.csv",
      description: "Hotel stay export derived from outbound travel itineraries",
      sourceEntityIds: sharedSourceEntityIds,
      adxTableName: "HotelStays",
      adxColumns: [
        { name: "stay_id", type: "string" },
        { name: "manifest_id", type: "string" },
        { name: "traveler_person_id", type: "string" },
        { name: "data_language", type: "string" },
        { name: "traveler_name", type: "string" },
        { name: "hotel_name", type: "string" },
        { name: "city", type: "string" },
        { name: "country_code", type: "string" },
        { name: "country_name", type: "string" },
        { name: "check_in_at", type: "datetime" },
        { name: "check_out_at", type: "datetime" },
        { name: "room_type", type: "string" },
        { name: "booking_status", type: "string" },
        { name: "payment_status", type: "string" },
        { name: "nightly_rate_local", type: "real" },
        { name: "currency", type: "string" },
        { name: "stay_purpose", type: "string" }
      ],
      header: [
        "stay_id",
        "manifest_id",
        "traveler_person_id",
        "data_language",
        "traveler_name",
        "hotel_name",
        "city",
        "country_code",
        "country_name",
        "check_in_at",
        "check_out_at",
        "room_type",
        "booking_status",
        "payment_status",
        "nightly_rate_local",
        "currency",
        "stay_purpose"
      ],
      rows: hotelStays.map((stay) => [
        stay.stayId,
        stay.manifestId,
        stay.travelerPersonId,
        stay.dataLanguage,
        stay.travelerName,
        stay.hotelName,
        stay.city,
        stay.countryCode,
        stay.countryName,
        stay.checkInAt,
        stay.checkOutAt,
        stay.roomType,
        stay.bookingStatus,
        stay.paymentStatus,
        stay.nightlyRateLocal,
        stay.currency,
        stay.stayPurpose
      ])
    },
    {
      relativePath: "exports/person-mentions.csv",
      description: "Person mention linkage export across reports, emails, vehicles, tolls, and border events",
      sourceEntityIds: pack.people.map((person) => person.id),
      adxTableName: "PersonMentions",
      adxColumns: [
        { name: "mention_id", type: "string" },
        { name: "person_id", type: "string" },
        { name: "person_name", type: "string" },
        { name: "source_table", type: "string" },
        { name: "source_record_id", type: "string" },
        { name: "mention_field", type: "string" },
        { name: "mentioned_value", type: "string" },
        { name: "data_language", type: "string" }
      ],
      header: [
        "mention_id",
        "person_id",
        "person_name",
        "source_table",
        "source_record_id",
        "mention_field",
        "mentioned_value",
        "data_language"
      ],
      rows: mentions.map((mention) => [
        mention.mentionId,
        mention.personId,
        mention.personName,
        mention.sourceTable,
        mention.sourceRecordId,
        mention.mentionField,
        mention.mentionedValue,
        mention.dataLanguage
      ])
    }
  ];
}

function buildAdxCreateTablesScript(datasets: CsvDataset[]): string {
  return [
    "// Run these commands in your Azure Data Explorer database context.",
    ...datasets.map((dataset) => `.create-merge table ${dataset.adxTableName} (${dataset.adxColumns.map((column) => `${column.name}:${column.type}`).join(", ")})`)
  ].join("\n\n");
}

function buildAdxMappingsScript(datasets: CsvDataset[]): string {
  return [
    "// CSV ingestion mappings aligned to the generated export headers.",
    ...datasets.map((dataset) => {
      const mapping = dataset.adxColumns.map((column, index) => ({
        Column: column.name,
        DataType: column.type,
        Ordinal: index
      }));

      return `.create-or-alter table ${dataset.adxTableName} ingestion csv mapping \"${dataset.adxTableName}CsvMapping\" '${JSON.stringify(mapping)}'`;
    })
  ].join("\n\n");
}

function buildAdxIngestCommandsScript(datasets: CsvDataset[]): string {
  return [
    "// Replace {OUTPUT_DIR} with your generated pack directory before running these commands.",
    ...datasets.map((dataset) => `.ingest into table ${dataset.adxTableName} ('{OUTPUT_DIR}/${dataset.relativePath.replaceAll("\\", "/")}') with (format='csv', ingestionMappingReference='${dataset.adxTableName}CsvMapping', ignoreFirstRecord=true)`)
  ].join("\n\n");
}

export async function generateCsvExports(pack: ScenarioPack, outputDir: string): Promise<OutputArtifact[]> {
  const artifacts: OutputArtifact[] = [];
  const datasets = [
    ...buildStandardCsvDatasets(pack),
    ...buildOperationalCsvDatasets(pack)
  ];

  for (const dataset of datasets) {
    await writeTextFile(outputDir, dataset.relativePath, buildCsv(dataset.header, dataset.rows));
    artifacts.push({
      id: `artifact-${dataset.relativePath.replace(/[/.]/g, "-")}`,
      type: "csv",
      relativePath: dataset.relativePath,
      description: dataset.description,
      sourceEntityIds: dataset.sourceEntityIds
    });
  }

  const allEntityIds = getAllEntityIds(pack);
  await writeTextFile(outputDir, "exports/adx-create-tables.kql", buildAdxCreateTablesScript(datasets));
  artifacts.push({
    id: "artifact-exports-adx-create-tables-kql",
    type: "kql",
    relativePath: "exports/adx-create-tables.kql",
    description: "ADX table creation script for generated CSV exports",
    sourceEntityIds: allEntityIds
  });

  await writeTextFile(outputDir, "exports/adx-create-mappings.kql", buildAdxMappingsScript(datasets));
  artifacts.push({
    id: "artifact-exports-adx-create-mappings-kql",
    type: "kql",
    relativePath: "exports/adx-create-mappings.kql",
    description: "ADX CSV ingestion mapping script for generated exports",
    sourceEntityIds: allEntityIds
  });

  await writeTextFile(outputDir, "exports/adx-ingest-commands.kql", buildAdxIngestCommandsScript(datasets));
  artifacts.push({
    id: "artifact-exports-adx-ingest-commands-kql",
    type: "kql",
    relativePath: "exports/adx-ingest-commands.kql",
    description: "ADX sample ingestion commands for generated CSV exports",
    sourceEntityIds: allEntityIds
  });

  return artifacts;
}
