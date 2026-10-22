// Tur başına seçilen sanatçı ülkesi. `name` kaynak sitelerin İngilizce yazımı
// (Saatchi kartlarında "→Ad, Turkey"), `slug` adresteki hali ("/drawings/turkey"),
// `iso` Artelivo taslağının `country` alanı.

export interface Country {
  iso: string;
  name: string;
  label: string;
}

export const COUNTRIES: Country[] = [
  { iso: "TR", name: "Turkey", label: "Türkiye" },
  { iso: "AZ", name: "Azerbaijan", label: "Azerbaycan" },
  { iso: "CY", name: "Cyprus", label: "Kıbrıs" },
  { iso: "GR", name: "Greece", label: "Yunanistan" },
  { iso: "BG", name: "Bulgaria", label: "Bulgaristan" },
  { iso: "GE", name: "Georgia", label: "Gürcistan" },
  { iso: "IR", name: "Iran", label: "İran" },
  { iso: "DE", name: "Germany", label: "Almanya" },
  { iso: "NL", name: "Netherlands", label: "Hollanda" },
  { iso: "FR", name: "France", label: "Fransa" },
  { iso: "IT", name: "Italy", label: "İtalya" },
  { iso: "ES", name: "Spain", label: "İspanya" },
  { iso: "GB", name: "United Kingdom", label: "Birleşik Krallık" },
  { iso: "US", name: "United States", label: "ABD" },
];

export const slugOf = (country: Country): string =>
  country.name.toLowerCase().replace(/[^a-z]+/g, "-");

export function countryByIso(iso: string | null | undefined): Country {
  return COUNTRIES.find((c) => c.iso === iso) ?? (COUNTRIES[0] as Country);
}
