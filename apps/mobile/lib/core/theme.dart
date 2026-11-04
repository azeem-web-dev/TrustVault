import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets/phosphor.dart';

/// Design tokens copied from apps/web/src/app/globals.css (Tailwind scale).
class C {
  static const brand50 = Color(0xFFEEF2FF);
  static const brand100 = Color(0xFFE0E7FF);
  static const brand200 = Color(0xFFC7D2FE);
  static const brand300 = Color(0xFFA5B4FC);
  static const brand400 = Color(0xFF818CF8);
  static const brand500 = Color(0xFF6366F1);
  static const brand600 = Color(0xFF4F46E5);
  static const brand700 = Color(0xFF4338CA);
  static const brand800 = Color(0xFF3730A3);
  static const brand900 = Color(0xFF312E81);
  static const brand950 = Color(0xFF1E1B4B);

  static const ink900 = Color(0xFF15162A);
  static const ink950 = Color(0xFF0C0D1A);
  static const ink975 = Color(0xFF05070F);
  static const night = Color(0xFF0D0B24);

  static const slate50 = Color(0xFFF8FAFC);
  static const slate100 = Color(0xFFF1F5F9);
  static const slate200 = Color(0xFFE2E8F0);
  static const slate300 = Color(0xFFCBD5E1);
  static const slate400 = Color(0xFF94A3B8);
  static const slate500 = Color(0xFF64748B);
  static const slate600 = Color(0xFF475569);
  static const slate700 = Color(0xFF334155);
  static const slate800 = Color(0xFF1E293B);
  static const slate900 = Color(0xFF0F172A);
  static const slate950 = Color(0xFF020617);

  static const emerald50 = Color(0xFFECFDF5);
  static const emerald100 = Color(0xFFD1FAE5);
  static const emerald200 = Color(0xFFA7F3D0);
  static const emerald300 = Color(0xFF6EE7B7);
  static const emerald500 = Color(0xFF10B981);
  static const emerald600 = Color(0xFF059669);
  static const emerald700 = Color(0xFF047857);
  static const emerald800 = Color(0xFF065F46);

  static const amber50 = Color(0xFFFFFBEB);
  static const amber100 = Color(0xFFFEF3C7);
  static const amber200 = Color(0xFFFDE68A);
  static const amber300 = Color(0xFFFCD34D);
  static const amber400 = Color(0xFFFBBF24);
  static const amber500 = Color(0xFFF59E0B);
  static const amber700 = Color(0xFFB45309);
  static const amber800 = Color(0xFF92400E);
  static const amber950 = Color(0xFF451A03);

  static const red50 = Color(0xFFFEF2F2);
  static const red100 = Color(0xFFFEE2E2);
  static const red200 = Color(0xFFFECACA);
  static const red300 = Color(0xFFFCA5A5);
  static const red500 = Color(0xFFEF4444);
  static const red600 = Color(0xFFDC2626);
  static const red700 = Color(0xFFB91C1C);
  static const red800 = Color(0xFF991B1B);

  static const sky50 = Color(0xFFF0F9FF);
  static const sky100 = Color(0xFFE0F2FE);
  static const sky200 = Color(0xFFBAE6FD);
  static const sky300 = Color(0xFF7DD3FC);
  static const sky500 = Color(0xFF0EA5E9);
  static const sky600 = Color(0xFF0284C7);
  static const sky700 = Color(0xFF0369A1);

  static const violet50 = Color(0xFFF5F3FF);
  static const violet200 = Color(0xFFDDD6FE);
  static const violet300 = Color(0xFFC4B5FD);
  static const violet500 = Color(0xFF8B5CF6);
  static const violet700 = Color(0xFF6D28D9);

  static const orange50 = Color(0xFFFFF7ED);
  static const orange100 = Color(0xFFFFEDD5);
  static const orange200 = Color(0xFFFED7AA);
  static const orange300 = Color(0xFFFDBA74);
  static const orange500 = Color(0xFFF97316);
  static const orange600 = Color(0xFFEA580C);
  static const orange700 = Color(0xFFC2410C);

  static const fuchsia600 = Color(0xFFC026D3);

  static const brandGradient = LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF5546E0), Color(0xFF7B2FD3)]);
  static const textGradient = LinearGradient(colors: [Color(0xFF7076F4), Color(0xFFC060E6)]);

  static const glow = [BoxShadow(color: Color(0x8C4F46E5), blurRadius: 20, offset: Offset(0, 8), spreadRadius: -6)];
  static const soft = [BoxShadow(color: Color(0x0A0F172A), blurRadius: 2, offset: Offset(0, 1)), BoxShadow(color: Color(0x140F172A), blurRadius: 16, offset: Offset(0, 4), spreadRadius: -4)];
  static const lift = [BoxShadow(color: Color(0x0A0F172A), blurRadius: 4, offset: Offset(0, 2)), BoxShadow(color: Color(0x400F172A), blurRadius: 40, offset: Offset(0, 16), spreadRadius: -12)];

  static const mono = 'GeistMono';
}

/// Motion tokens, mirroring the web's --duration-* / --ease-* (§2.3).
/// Use [Motion.of] so durations collapse to zero when the system asks for
/// reduced motion (Settings > Accessibility > Remove animations).
class Motion {
  static const fast = Duration(milliseconds: 120);
  static const base = Duration(milliseconds: 200);
  static const slow = Duration(milliseconds: 320);
  static const easeOut = Cubic(0.2, 0.8, 0.2, 1);
  static const easeIn = Cubic(0.4, 0, 1, 1);
  static const spring = Cubic(0.3, 1.3, 0.5, 1);
  static const curve = Curves.easeOutCubic;

  /// True when the platform asks for reduced / no animations.
  static bool reduced(BuildContext context) => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  /// [d], or zero under reduced motion.
  static Duration of(BuildContext context, [Duration d = base]) => reduced(context) ? Duration.zero : d;
}

/// Colours that change with light / dark, like the web's `dark:` variants.
/// The semantic names (bg, surface, surface2, raised, line, lineStrong, fg,
/// muted, subtle, success…) mirror the web tokens in globals.css.
class Pal {
  const Pal(this.dark);
  final bool dark;
  static Pal of(BuildContext c) => Pal(Theme.of(c).brightness == Brightness.dark);

  Color get bg => dark ? C.ink950 : C.slate50;
  Color get surface => dark ? const Color(0xFF13142A) : Colors.white;
  Color get card => dark ? const Color(0xFF111225) : Colors.white;
  Color get raised => dark ? C.ink900 : Colors.white;
  Color get border => dark ? Colors.white.withValues(alpha: 0.08) : C.slate200.withValues(alpha: 0.8);
  Color get divider => dark ? Colors.white.withValues(alpha: 0.06) : C.slate100;
  Color get text => dark ? C.slate100 : C.slate900;
  Color get strong => dark ? Colors.white : C.slate900;
  Color get body => dark ? C.slate300 : C.slate700;
  Color get muted => dark ? C.slate400 : C.slate500;
  /// Small secondary text. slate500 on light (≥ 4.5:1 on white), slate400 on dark (R11).
  Color get faint => dark ? C.slate400 : C.slate500;
  Color get field => dark ? Colors.white.withValues(alpha: 0.04) : Colors.white;
  Color get fieldBorder => dark ? Colors.white.withValues(alpha: 0.10) : C.slate200;
  Color get soft => dark ? Colors.white.withValues(alpha: 0.05) : C.slate50;
  Color get soft2 => dark ? Colors.white.withValues(alpha: 0.10) : C.slate100;
  Color get accent => dark ? C.brand300 : C.brand600;
  Color get selectedBg => dark ? C.brand500.withValues(alpha: 0.12) : C.brand50;
  Color get selectedBorder => dark ? C.brand400.withValues(alpha: 0.6) : C.brand400;
  List<BoxShadow> get shadow => dark ? const [] : C.soft;

  // Semantic tokens (web: bg-surface-2, border-line, text-fg, text-fg-subtle…).
  Color get surface2 => dark ? C.ink900 : C.slate50;
  Color get line => border;
  Color get lineStrong => dark ? Colors.white.withValues(alpha: 0.15) : C.slate300;
  /// Dashed borders (drop zones, empty slots).
  Color get dashed => dark ? Colors.white.withValues(alpha: 0.18) : C.slate300;
  Color get fg => text;
  /// Same contrast rule as [faint]; the web's text-fg-subtle.
  Color get subtle => faint;

  // Status colours for text and icons, readable on [card] in both themes.
  Color get success => dark ? C.emerald300 : C.emerald600;
  Color get warning => dark ? C.amber300 : C.amber700;
  Color get danger => dark ? C.red300 : C.red600;
  Color get info => dark ? C.sky300 : C.sky600;
  Color get severe => dark ? C.orange300 : C.orange600;
}

/// One severity scale for web and mobile (§2.1): critical red, high orange,
/// medium amber, low blue, info slate. [color] is the solid pill / bar
/// colour and [fg] the text drawn on it.
class SeverityStyle {
  const SeverityStyle(this.label, this.color, this.fg, this.tone, this.icon);
  final String label;
  final Color color;
  final Color fg;
  final Tone tone;
  final PI icon;
}

const _severity = {
  'critical': SeverityStyle('Critical', C.red600, Colors.white, Tone.red, PhosphorIconsFill.warningOctagon),
  'high': SeverityStyle('High', C.orange500, Colors.white, Tone.orange, PhosphorIconsFill.warning),
  'medium': SeverityStyle('Medium', C.amber500, C.amber950, Tone.amber, PhosphorIconsFill.warning),
  'low': SeverityStyle('Low', C.sky500, Colors.white, Tone.blue, PhosphorIconsFill.info),
  'info': SeverityStyle('Info', C.slate500, Colors.white, Tone.neutral, PhosphorIconsFill.info),
};

/// Style for an alert severity ('critical', 'HIGH', …). Unknown values read as info.
SeverityStyle severityStyle(String? severity) => _severity[(severity ?? '').toLowerCase()] ?? _severity['info']!;

/// Human label for an alert status ('open' → 'Open', 'acknowledged' → 'Acknowledged').
String statusLabel(String? status) {
  final s = (status ?? '').trim().toLowerCase();
  const known = {'open': 'Open', 'acknowledged': 'Acknowledged', 'assigned': 'Assigned', 'resolved': 'Resolved', 'reopened': 'Reopened'};
  if (known.containsKey(s)) return known[s]!;
  if (s.isEmpty) return 'Unknown';
  final words = s.replaceAll(RegExp(r'[_\-]+'), ' ');
  return words[0].toUpperCase() + words.substring(1);
}

/// Badge tone for an alert status.
Tone statusTone(String? status) => switch ((status ?? '').toLowerCase()) {
  'open' => Tone.red,
  'acknowledged' => Tone.amber,
  'assigned' => Tone.blue,
  'resolved' => Tone.green,
  _ => Tone.neutral,
};

enum Tone { neutral, green, amber, orange, red, blue, violet, brand, slate }

class ToneColors {
  const ToneColors(this.bg, this.fg, this.ring, this.dot);
  final Color bg, fg, ring, dot;
}

ToneColors toneOf(Tone t, bool dark) {
  Color a(Color c, double o) => c.withValues(alpha: o);
  switch (t) {
    case Tone.neutral:
    case Tone.slate:
      return dark ? ToneColors(a(Colors.white, .10), C.slate300, a(Colors.white, .10), C.slate400) : const ToneColors(C.slate100, C.slate700, C.slate200, C.slate400);
    case Tone.green:
      return dark ? ToneColors(a(C.emerald500, .12), C.emerald300, a(C.emerald500, .25), C.emerald500) : const ToneColors(C.emerald50, C.emerald700, C.emerald200, C.emerald500);
    case Tone.amber:
      return dark ? ToneColors(a(C.amber500, .12), C.amber300, a(C.amber500, .25), C.amber500) : const ToneColors(C.amber50, C.amber800, C.amber200, C.amber500);
    case Tone.orange:
      return dark ? ToneColors(a(C.orange500, .12), C.orange300, a(C.orange500, .25), C.orange500) : const ToneColors(C.orange50, C.orange700, C.orange200, C.orange500);
    case Tone.red:
      return dark ? ToneColors(a(C.red500, .12), C.red300, a(C.red500, .25), C.red500) : const ToneColors(C.red50, C.red700, C.red200, C.red500);
    case Tone.blue:
      return dark ? ToneColors(a(C.sky500, .12), C.sky300, a(C.sky500, .25), C.sky500) : const ToneColors(C.sky50, C.sky700, C.sky200, C.sky500);
    case Tone.violet:
      return dark ? ToneColors(a(C.violet500, .12), C.violet300, a(C.violet500, .25), C.violet500) : const ToneColors(C.violet50, C.violet700, C.violet200, C.violet500);
    case Tone.brand:
      return dark ? ToneColors(a(C.brand500, .15), C.brand300, a(C.brand500, .25), C.brand500) : const ToneColors(C.brand50, C.brand600, C.brand200, C.brand500);
  }
}

ThemeData buildTheme(Brightness b) {
  final dark = b == Brightness.dark;
  final p = Pal(dark);
  final scheme = ColorScheme.fromSeed(seedColor: C.brand600, brightness: b).copyWith(primary: dark ? C.brand400 : C.brand600, surface: p.surface, onSurface: p.text, error: C.red600);
  OutlineInputBorder border(Color c, [double w = 1]) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(10),
    borderSide: BorderSide(color: c, width: w),
  );
  final base = ThemeData(useMaterial3: true, brightness: b, colorScheme: scheme, fontFamily: 'Geist', scaffoldBackgroundColor: p.bg, splashFactory: InkSparkle.splashFactory, dividerColor: p.divider);
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: p.text, displayColor: p.text, fontFamily: 'Geist'),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: p.text,
      systemOverlayStyle: dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.field,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      hintStyle: const TextStyle(color: C.slate400, fontSize: 14),
      border: border(p.fieldBorder),
      enabledBorder: border(p.fieldBorder),
      focusedBorder: border(dark ? C.brand400 : C.brand500, 1.6),
      errorBorder: border(C.red500),
      focusedErrorBorder: border(C.red500, 1.6),
      prefixIconColor: C.slate400,
      suffixIconColor: C.slate400,
    ),
    textSelectionTheme: TextSelectionThemeData(cursorColor: C.brand500, selectionColor: C.brand500.withValues(alpha: .25), selectionHandleColor: C.brand500),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: p.raised, surfaceTintColor: Colors.transparent, showDragHandle: true, dragHandleColor: p.soft2),
    dialogTheme: DialogThemeData(backgroundColor: p.raised, surfaceTintColor: Colors.transparent),
    popupMenuTheme: PopupMenuThemeData(
      color: p.raised,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: p.border),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
    datePickerTheme: DatePickerThemeData(backgroundColor: p.raised, surfaceTintColor: Colors.transparent),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: C.brand500),
  );
}
