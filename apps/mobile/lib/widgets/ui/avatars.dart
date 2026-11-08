import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../core/theme.dart';

import 'basics.dart';

/* ----------------------------------------------------------------- avatars */

const _avatarGradients = [
  [Color(0xFF6366F1), Color(0xFF8B5CF6)],
  [Color(0xFF0EA5E9), Color(0xFF6366F1)],
  [Color(0xFF10B981), Color(0xFF14B8A6)],
  [Color(0xFFF59E0B), Color(0xFFF97316)],
  [Color(0xFFF43F5E), Color(0xFFEC4899)],
  [Color(0xFFD946EF), Color(0xFFA855F7)],
  [Color(0xFF06B6D4), Color(0xFF3B82F6)],
  [Color(0xFF84CC16), Color(0xFF10B981)],
];

class Avatar extends StatelessWidget {
  const Avatar(this.name, {super.key, this.size = 36});
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) {
    var h = 0;
    for (final r in name.runes) {
      final unit = r > 0xFFFF ? 0xD800 + ((r - 0x10000) >> 10) : r;
      h = (h * 31 + unit) & 0xFFFFFFFF;
    }
    final g = _avatarGradients[h % _avatarGradients.length];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: g),
        border: Border.all(color: Pal.of(context).dark ? C.ink950 : Colors.white, width: size > 30 ? 2 : 1.5),
      ),
      child: Center(
        child: Text(
          initials(name),
          style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: size * 0.36),
        ),
      ),
    );
  }
}

class AvatarStack extends StatelessWidget {
  const AvatarStack(this.names, {super.key, this.max = 5, this.size = 30});
  final List<String> names;
  final int max;
  final double size;
  @override
  Widget build(BuildContext context) {
    final shown = names.take(max).toList();
    final extra = names.length - shown.length;
    final count = shown.length + (extra > 0 ? 1 : 0);
    final p = Pal.of(context);
    return SizedBox(
      height: size,
      width: count == 0 ? 0 : size + (count - 1) * size * 0.72,
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * size * 0.72,
              child: Avatar(shown[i], size: size),
            ),
          if (extra > 0)
            Positioned(
              left: shown.length * size * 0.72,
              child: Container(
                width: size,
                height: size,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: p.soft2,
                  border: Border.all(color: p.dark ? C.ink950 : Colors.white, width: 2),
                ),
                child: Center(
                  child: Text(
                    '+$extra',
                    style: ts(context, size: 10.5, w: FontWeight.w600, color: p.body),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
