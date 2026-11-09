import { Component } from '@angular/core'

/** Let Tabby supply the theme, geometry and pointer behavior of its standard settings toggle. */
@Component({
    selector: 'trd-settings-toggle',
    standalone: false,
    template: '<toggle [model]="model" (click)="change()"></toggle>',
})
export class SettingsToggleComponent {
    model = false
    changed: (value: boolean) => void = () => { }

    change (): void {
        this.model = !this.model
        this.changed(this.model)
    }
}
