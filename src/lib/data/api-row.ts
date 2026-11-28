/** Typed snake-case transport rows for the portable Data API. */
type Snake<S extends string> = S extends `${infer Head}${infer Tail}` ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${Snake<Tail>}` : S;
export type ApiRow<T> = { [K in keyof T as K extends string ? Snake<K> : never]: T[K] };
