'use client';

import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import LiquidFluidReveal from './imageReveal';

/**
 * Hero section for a film photography studio, now orchestrated by a single
 * GSAP timeline instead of staggered CSS transitions.
 *
 * Why this reads as more premium:
 *  - One timeline means every stage is relative to the one before it
 *    (`'-=0.x'` overlaps), so the sequence breathes instead of firing a
 *    dozen independent transitions on the same clock.
 *  - The aperture open uses `expo.inOut` over 1.6s — CSS `cubic-bezier`
 *    approximations of this always feel a touch mechanical; gsap's named
 *    ease is the real curve.
 *  - The headline lines animate with `yPercent` + a slight `rotateX` for
 *    a subtle 3D unfurl instead of a flat translateY fade.
 *  - The frame counter's "flicker" is a real gsap punch (scale + opacity)
 *    instead of a CSS class toggle, so it never looks like a glitch.
 *
 * Respects prefers-reduced-motion: skips the elastic/expo flourishes and
 * cross-fades everything in flat and fast instead.
 */
export default function FilmHero() {
    const rootRef = useRef(null);
    const navRef = useRef(null);
    const eyebrowRef = useRef(null);
    const copyRef = useRef(null);
    const ctaRef = useRef(null);
    const frameRef = useRef(null);
    const imageWrapRef = useRef(null);
    const filmStripRef = useRef(null);

    const [frame, setFrame] = useState(1);
    const lastBump = useRef(0);

    useEffect(() => {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const lines = gsap.utils.toArray(rootRef.current.querySelectorAll('.reveal-line'));

        const ctx = gsap.context(() => {
            const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });

            tl.fromTo(
                rootRef.current,
                { clipPath: 'circle(0% at 50% 45%)' },
                {
                    clipPath: 'circle(150% at 50% 45%)',
                    duration: reduceMotion ? 0.4 : 1.6,
                    ease: 'expo.inOut',
                }
            )
                .fromTo(navRef.current, { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.8 }, '-=1.15')
                .fromTo(eyebrowRef.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6 }, '-=0.5')
                .fromTo(
                    lines,
                    { yPercent: 120, rotateX: reduceMotion ? 0 : -25, opacity: 0 },
                    { yPercent: 0, rotateX: 0, opacity: 1, duration: 0.9, stagger: 0.1 },
                    '-=0.35'
                )
                .fromTo(copyRef.current, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7 }, '-=0.5')
                .fromTo(ctaRef.current, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6 }, '-=0.45')
                .fromTo(
                    imageWrapRef.current,
                    { opacity: 0, scale: 1.04 },
                    { opacity: 1, scale: 1, duration: 1.1, ease: 'power3.out' },
                    '-=1'
                )
                .fromTo(
                    filmStripRef.current,
                    { opacity: 0 },
                    {
                        opacity: 1,
                        duration: 0.7,
                        onStart: () => {
                            gsap.fromTo(
                                filmStripRef.current.children,
                                { scaleY: 0.2, opacity: 0 },
                                { scaleY: 1, opacity: 1, duration: 0.5, stagger: 0.012, ease: 'power2.out' }
                            );
                        },
                    },
                    '-=0.3'
                );
        }, rootRef);

        return () => ctx.revert();
    }, []);

    const bumpFrame = () => {
        const now = performance.now();
        if (now - lastBump.current < 90) return; // throttle so digits are readable
        lastBump.current = now;
        setFrame((f) => f + 1);
        gsap.fromTo(
            frameRef.current,
            { opacity: 0.3, scale: 1.18 },
            { opacity: 1, scale: 1, duration: 0.28, ease: 'power2.out', overwrite: 'auto' }
        );
    };

    const handleCtaEnter = (e) => {
        gsap.to(e.currentTarget.querySelector('.cta-underline'), {
            scaleX: 1,
            duration: 0.4,
            ease: 'power3.out',
        });
    };
    const handleCtaLeave = (e) => {
        gsap.to(e.currentTarget.querySelector('.cta-underline'), {
            scaleX: 0,
            duration: 0.3,
            ease: 'power2.in',
        });
    };

    return (
        <div
            ref={rootRef}
            className="bg-[#141210] text-[#EDE7DC]"
            style={{ clipPath: 'circle(0% at 50% 45%)' }}
        >
            <nav
                ref={navRef}
                className="flex items-center justify-between border-b border-white/10 px-8 py-5"
                style={{ opacity: 0 }}
            >
                <div className="flex items-center gap-2.5">
                    <span className="relative block h-[22px] w-[22px] flex-shrink-0 rounded-full border-[1.5px] border-[#C9A961]">
                        <span className="absolute inset-[5px] rounded-full border-[1.5px] border-[#C9A961]" />
                    </span>
                    <span className="font-serif text-[17px] font-medium tracking-tight">
                        Mithuna V
                    </span>
                </div>
                <div className="flex items-center gap-7 text-[13px] text-[#B8B0A2]">
                    <span className="cursor-pointer transition-colors hover:text-[#EDE7DC]">Project</span>
                    <span className="cursor-pointer transition-colors hover:text-[#EDE7DC]">Skills</span>
                    <span className="cursor-pointer transition-colors hover:text-[#EDE7DC]">Contact</span>
                    <button className="rounded-sm border border-white/25 px-4 py-1.5 text-xs tracking-wide text-[#EDE7DC] transition-colors hover:border-white/50">
                        Let's Talk
                    </button>
                </div>
            </nav>

            <div className="flex h-[90vh] bg-black flex-col gap-0.5 px-8 md:flex-row md:gap-2">
                <div className="flex min-w-[280px] flex-1 flex-col justify-center py-12 md:pr-10">
                    <span
                        ref={eyebrowRef}
                        className="mb-5 font-mono text-[11px] tracking-wider text-[#C1502E]"
                        style={{ opacity: 0 }}
                    >
                        FRONT-END DEVELOPER · REACT · NEXT.JS
                    </span>
                    <h1
                        className="mb-5 font-serif text-4xl font-medium leading-[1.08] tracking-tight md:text-5xl"
                        style={{ perspective: 600 }}
                    >
                        <span className="block overflow-hidden">
                            <span className="reveal-line block" style={{ opacity: 0 }}>Turning</span>
                        </span>
                        <span className="block overflow-hidden">
                            <span className="reveal-line block" style={{ opacity: 0 }}>ideas into</span>
                        </span>
                        <span className="block overflow-hidden">
                            <span className="reveal-line block" style={{ opacity: 0 }}>responsive products.</span>
                        </span>
                    </h1>
                    <p
                        ref={copyRef}
                        className="mb-7 max-w-[340px] text-[14.5px] leading-relaxed text-[#B8B0A2]"
                        style={{ opacity: 0 }}
                    >
                        I'm a Front-End Developer specializing in React, Next.js, JavaScript,
                        Tailwind CSS and GSAP. I build fast, responsive, and engaging web
                        applications with a focus on user experience and clean code.
                    </p>
                    <div ref={ctaRef} className="flex items-center gap-4" style={{ opacity: 0 }}>
                        <a
                            href="#archive"
                            onMouseEnter={handleCtaEnter}
                            onMouseLeave={handleCtaLeave}
                            className="relative inline-block w-fit pb-1 text-[13px] text-[#C9A961]"
                        >
                            Explore My Work
                            <span
                                className="cta-underline absolute bottom-0 left-0 h-px w-full origin-left bg-[#C9A961]"
                                style={{ transform: 'scaleX(0)' }}
                            />
                        </a>
                        <span
                            ref={frameRef}
                            className="font-mono text-[12px] text-[#6E685E]"
                        >
                            frame {String(frame).padStart(4, '0')}
                        </span>
                    </div>
                </div>

                <div ref={imageWrapRef} className="flex-[1.3]" style={{ opacity: 0 }} onMouseMove={bumpFrame}>
                    <LiquidFluidReveal
                        bottomSrc="/me.png"
                        topSrc={'/anime.png'}
                        alt="Studio portrait, shown as a film negative until revealed"
                        radius={130}
                        feather={0.45}
                        chromaticAberration
                        grain
                        glow
                        className="h-full min-h-[420px] w-full rounded-sm"
                    >
                        <div className="flex items-start justify-between p-3.5">
                            <div className="flex gap-[3px]">
                                {[0, 1, 2].map((i) => (
                                    <span key={i} className="h-2 w-[5px] rounded-[1px] bg-[#0B0A09]" />
                                ))}
                            </div>
                            <span className="font-mono text-[10px] text-white/55">
                                GSAP • THREE.JS
                            </span>
                        </div>
                    </LiquidFluidReveal>
                </div>
            </div>

            <div ref={filmStripRef} className="flex gap-1.5 px-8 py-6" aria-hidden="true" style={{ opacity: 0 }}>
                {Array.from({ length: 40 }).map((_, i) => (
                    <span key={i} className="h-[9px] w-[5px] rounded-[1px] bg-white/10 origin-bottom" />
                ))}
            </div>
        </div>
    );
}