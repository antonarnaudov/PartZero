/**
 * `MeasureStore`: whether the Measure panel is open. Results are derived from the selection
 * (`measureSelection`), so they follow every click and every regeneration.
 */
import { Store } from "../store";

export interface MeasureState {
  open: boolean;
}

export class MeasureStore extends Store<MeasureState> {
  constructor() {
    super({ open: false });
  }

  setOpen(open: boolean): void {
    this.setState({ open });
  }
}
