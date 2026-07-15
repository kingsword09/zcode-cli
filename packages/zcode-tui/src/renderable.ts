import type { Component } from "@earendil-works/pi-tui";

export interface ExpandableComponent extends Component {
  setExpanded(expanded: boolean): void;
  isExpanded(): boolean;
  hasHiddenContent(): boolean;
}

export interface SearchableComponent extends Component {
  getSearchText(): string;
}

export interface WindowedRenderResult {
  lines: string[];
  totalLines: number;
}

/** Optional fast path for components that can render only a requested line page. */
export interface WindowedComponent extends Component {
  renderWindow(width: number, start: number, count: number): WindowedRenderResult;
}

export function isExpandableComponent(component: Component): component is ExpandableComponent {
  const candidate = component as Partial<ExpandableComponent>;
  return typeof candidate.setExpanded === "function"
    && typeof candidate.isExpanded === "function"
    && typeof candidate.hasHiddenContent === "function";
}

export function isSearchableComponent(component: Component): component is SearchableComponent {
  return typeof (component as Partial<SearchableComponent>).getSearchText === "function";
}

export function isWindowedComponent(component: Component): component is WindowedComponent {
  return typeof (component as Partial<WindowedComponent>).renderWindow === "function";
}
