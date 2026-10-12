import { findNativePickers } from './native-pickers';

const types = (source: string) => findNativePickers(source).map((found) => `${found.line}:${found.type}`);

describe('findNativePickers', () => {
  it('flags native date and time inputs in a template', () => {
    const template = `
      <input type="date" [value]="due" />
      <input
        class="x"
        type='time'
      />
      <input TYPE="datetime-local">
      <input type="month"><input type="week">
    `;
    expect(types(template)).toEqual(['2:date', '3:time', '7:datetime-local', '8:month', '8:week']);
  });

  it('flags a bound type and one set from code', () => {
    expect(types(`<input [type]="'date'" />`)).toEqual(['1:date']);
    expect(types(`<input [attr.type]="'time'" />`)).toEqual(['1:time']);
    expect(types(`input.type = 'date';\nel.setAttribute('type', "week");`)).toEqual(['1:date', '2:week']);
  });

  it('passes text inputs, the kit DatePicker and selectors in specs', () => {
    const source = `
      <input type="text" inputmode="numeric" />
      <tc-date-picker [min]="today" />
      <input [type]="field.type ?? 'text'" />
      const input: ConfirmInput = { type: 'date', label };
      dialog.querySelector('input[type="date"]');
      // the native <input type> picker is gone
    `;
    expect(findNativePickers(source)).toEqual([]);
  });
});
