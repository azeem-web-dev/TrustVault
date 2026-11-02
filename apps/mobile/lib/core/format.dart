import 'package:intl/intl.dart';

String formatBytes(num n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
  return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
}

DateTime? parseIso(String? iso) => iso == null ? null : DateTime.tryParse(iso)?.toLocal();

String formatDate(String? iso) {
  final d = parseIso(iso);
  if (d == null) return '—';
  return DateFormat('d MMM y, HH:mm').format(d);
}

String formatDay(String? iso) {
  final d = parseIso(iso);
  if (d == null) return '—';
  return DateFormat('d MMM y').format(d);
}

String relativeTime(String? iso) {
  final d = parseIso(iso);
  if (d == null) return 'never';
  final diff = DateTime.now().difference(d);
  final s = diff.inSeconds;
  final abs = s.abs();
  String unit(int v, String u) {
    if (v == 0) return u == 'second' ? 'now' : 'this $u';
    final n = v.abs();
    final word = n == 1 ? u : '${u}s';
    if (u == 'day' && v == 1) return 'yesterday';
    if (u == 'day' && v == -1) return 'tomorrow';
    return v > 0 ? '$n $word ago' : 'in $n $word';
  }

  if (abs < 60) return unit(s, 'second');
  if (abs < 3600) return unit((s / 60).round(), 'minute');
  if (abs < 86400) return unit((s / 3600).round(), 'hour');
  if (abs < 86400 * 30) return unit((s / 86400).round(), 'day');
  return DateFormat('d MMM y').format(d);
}

String greeting() {
  final h = DateTime.now().hour;
  return h < 12
      ? 'Good morning'
      : h < 18
      ? 'Good afternoon'
      : 'Good evening';
}

String initials(String name) {
  final parts = name.replaceAll(RegExp(r'[^\p{L}\p{N} ]', unicode: true), ' ').trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  final first = String.fromCharCode(parts.first.runes.first);
  final last = parts.length > 1 ? String.fromCharCode(parts.last.runes.first) : '';
  return (first + last).toUpperCase();
}

String isoDay(DateTime d) => DateFormat('yyyy-MM-dd').format(d);
