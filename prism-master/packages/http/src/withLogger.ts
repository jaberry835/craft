import { asks } from 'fp-ts/Reader';
import { Logger } from 'pino';

export default function withLogger<T>(run: (E: Logger) => T) {
  return asks<Logger, T>(run);
}
