import type { Component } from "@earendil-works/pi-tui";

export interface ExpandableComponent extends Component {
  setExpanded(expanded: boolean): void;
  isExpanded(): boolean;
  hasHiddenContent(): boolean;
}

export interface SearchableComponent extends Component {
  getSearchText(): string;
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
