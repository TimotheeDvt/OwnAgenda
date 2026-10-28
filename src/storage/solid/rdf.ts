import { Parser, type Quad } from 'n3';

export const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
export const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#storage';
export const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';
const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';
const FOAF_IMG = 'http://xmlns.com/foaf/0.1/img';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';
const VCARD_PHOTO = 'http://www.w3.org/2006/vcard/ns#hasPhoto';

/** Parses a Turtle document; relative IRIs are resolved against `baseIRI` (the document URL). */
export function parseTurtle(text: string, baseIRI: string): Quad[] {
  return new Parser({ baseIRI }).parse(text);
}

/** Values of `predicate` for `subject`, in document order. */
export function objectsOf(quads: Quad[], subject: string, predicate: string): string[] {
  return quads
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value);
}

export interface SolidProfile {
  webId: string;
  /** Root of the pod (ends with "/"). */
  storage: string;
  /** OpenID provider the person signs in with. */
  issuer: string | null;
  name: string | null;
  photo: string | null;
}

/** Reads the parts of a WebID profile document the app needs. */
export function parseProfile(webId: string, text: string): SolidProfile {
  const docUrl = webId.split('#')[0] ?? webId;
  const quads = parseTurtle(text, docUrl);
  const first = (...predicates: string[]) =>
    predicates.flatMap((p) => objectsOf(quads, webId, p))[0] ?? null;
  const storage = first(PIM_STORAGE) ?? new URL('/', webId).href;
  return {
    webId,
    storage: storage.endsWith('/') ? storage : `${storage}/`,
    issuer: first(SOLID_OIDC_ISSUER),
    name: first(FOAF_NAME, VCARD_FN),
    photo: first(VCARD_PHOTO, FOAF_IMG),
  };
}
