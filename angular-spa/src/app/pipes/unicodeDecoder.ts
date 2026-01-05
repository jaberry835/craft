import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'unicodeDecoder',
  standalone: true 
})
export class UnicodeDecoderPipe implements PipeTransform {

  transform(value: string): string {
    if (!value) {
      return value;
    }

    // Replace Unicode sequences like \uXXXX with their decoded characters
    return value.replace(/\\u[\dA-Fa-f]{4}/g, (match) => {
      return String.fromCharCode(parseInt(match.replace('\\u', ''), 16));
    });
  }
}
