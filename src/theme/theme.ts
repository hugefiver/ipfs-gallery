import { createTheme } from '@mui/material/styles'

export const galleryTheme = createTheme({
  cssVariables: false,
  palette: {
    primary: { main: '#1D1D1F', dark: '#000000', contrastText: '#FFFFFF' },
    background: { default: '#141414', paper: '#FFFFFF' },
    text: { primary: '#1D1D1F', secondary: '#6E6E73' },
    error: { main: '#D73A49' }, warning: { main: '#C97A1E' },
  },
  spacing: 4,
  shape: { borderRadius: 8 },
  zIndex: { modal: 40 },
  typography: {
    fontFamily: 'var(--font-body)',
    fontSize: 16,
    button: { textTransform: 'none', fontSize: 'var(--type-label)', fontWeight: 500 },
    body1: { fontSize: 'var(--type-body)', lineHeight: 1.75 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true, disableRipple: true }, styleOverrides: { root: {
      minWidth: 'var(--control-min)', minHeight: 'var(--control-height)', padding: 'var(--space-3) var(--space-4)', boxShadow: 'var(--shadow-none)',
      transition: 'background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.1s ease',
      borderRadius: 'var(--radius-control)', color: 'var(--accent-primary)', fontWeight: 500, letterSpacing: '0.01em',
      '&:active': { transform: 'scale(0.985)' },
      '&.Mui-focusVisible': { outline: 'var(--focus-width) solid var(--accent-primary)', outlineOffset: 'var(--focus-offset)' },
      '&.Mui-disabled': { color: 'var(--text-secondary)', background: 'transparent', opacity: 0.38 },
    }, outlined: { borderColor: 'var(--border-control)', backgroundColor: 'var(--surface-paper)', color: 'var(--text-primary)', '&:hover': { backgroundColor: 'var(--surface-soft)', borderColor: 'var(--text-primary)' } },
    contained: { color: 'var(--text-on-accent)', backgroundColor: 'var(--accent-primary)', boxShadow: 'var(--elevation-2)', '&:hover': { backgroundColor: 'var(--accent-pressed)', boxShadow: 'var(--elevation-4)' }, '&:active': { boxShadow: 'var(--elevation-8)' } },
    text: { '&:hover': { backgroundColor: 'var(--surface-soft)' } } } },
    MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'rgba(0, 0, 0, 0.5) !important', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } } },
    MuiDialog: { styleOverrides: { paper: { boxShadow: 'none', borderRadius: 'var(--radius-panel)', border: 'var(--border-width) solid var(--border-subtle)' } } },
  },
})
