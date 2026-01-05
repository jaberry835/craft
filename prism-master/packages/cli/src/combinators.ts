import * as E from 'fp-ts/Either';
import { sequenceS } from 'fp-ts/Apply';

export const sequenceSEither = sequenceS(E.Apply);
