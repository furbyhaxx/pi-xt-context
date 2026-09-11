// Minimal stand-in for @earendil-works/pi-tui under vitest.

export class Text {
  constructor(
    public text = "",
    public padX = 0,
    public padY = 0,
    public bg?: (text: string) => string,
  ) {}
  setText(text: string) {
    this.text = text;
  }
  invalidate() {}
  render(_width: number): string[] {
    return [this.text];
  }
}

export class Container {
  children: Array<{ render?: (w: number) => string[]; invalidate?: () => void }> = [];
  addChild(c: { render?: (w: number) => string[]; invalidate?: () => void }) {
    this.children.push(c);
  }
  render(width: number): string[] {
    return this.children.flatMap((c) => c.render?.(width) ?? []);
  }
  invalidate() {
    for (const c of this.children) c.invalidate?.();
  }
}

export class SettingsList {
  constructor(
    public items: unknown[],
    public maxVisible: number,
    public theme: unknown,
    public onChange: (id: string, value: string) => void,
    public onCancel: () => void,
  ) {}
  updateValue(_id: string, _value: string) {}
  selectItem(_id: string) {}
  handleInput(_data: string) {}
  invalidate() {}
  render(_width: number): string[] {
    return [];
  }
}

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
};

export type SettingItem = {
  id: string;
  label: string;
  currentValue: string;
  values?: string[];
  description?: string;
};
