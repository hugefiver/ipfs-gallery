import { createTheme } from '@mui/material/styles'

export const galleryTheme = createTheme({
  cssVariables: false,
  palette: {
    primary: { main: '#5C633F', dark: '#464D30', contrastText: '#FAF9F5' },
    background: { default: '#181715', paper: '#FAF9F5' },
    text: { primary: '#252523', secondary: '#55564E' },
    error: { main: '#923D32' }, warning: { main: '#755419' },
  },
  spacing: 4,
  shape: { borderRadius: 4 },
  zIndex: { modal: 40 },
  typography: {
    fontFamily: 'var(--font-body)',
    fontSize: 16,
    button: { textTransform: 'none', fontSize: 'var(--type-label)', fontWeight: 500 },
    body1: { fontSize: 'var(--type-body)', lineHeight: 1.75 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true, disableRipple: true }, styleOverrides: { root: {
      minWidth: 'var(--control-min)', minHeight: 'var(--control-height)', padding: 'var(--space-3) var(--space-4)', boxShadow: 'var(--shadow-none)', transition: 'none',
      borderRadius: 'var(--radius-control)', color: 'var(--accent-primary)',
      '&.Mui-focusVisible': { outline: 'var(--focus-width) solid var(--accent-primary)', outlineOffset: 'var(--focus-offset)' },
      '&.Mui-disabled': { color: 'var(--text-secondary)', background: 'var(--surface-muted)' },
    }, outlined: { borderColor: 'var(--border-control)', '&:hover': { backgroundColor: 'var(--surface-soft)' } },
    contained: { color: 'var(--text-on-accent)', backgroundColor: 'var(--accent-primary)', '&:hover': { backgroundColor: 'var(--accent-pressed)' } },
    text: { '&:hover': { backgroundColor: 'var(--surface-soft)' } } } },
    MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'var(--surface-overlay-backdrop)' } } },
    MuiDialog: { styleOverrides: { paper: { boxShadow: 'none', borderRadius: 'var(--radius-panel)', border: 'var(--border-width) solid var(--border-subtle)' } } },
  },
})
