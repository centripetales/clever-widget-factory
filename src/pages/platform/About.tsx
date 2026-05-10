import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Archive, ClipboardList, Tractor } from "lucide-react";

export default function About() {
  return (
    <div className="flex flex-col">
      {/* Page header */}
      <section className="bg-muted/40 py-14 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            About Centripetal ES
          </h1>
          <p className="text-muted-foreground text-base sm:text-lg">
            A structured record system for agricultural operations — built on
            real farm usage.
          </p>
        </div>
      </section>

      {/* System overview */}
      <section className="py-16 px-6 bg-background">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <Archive className="h-6 w-6 text-green-600 flex-shrink-0" />
            <h2 className="text-2xl font-semibold">System overview</h2>
          </div>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Centripetal ES is an asset management and accountability system
            designed for farms and agricultural operations. It provides a
            single place to track tools, parts, and work activities — linking
            observations to actions and actions to outcomes over time.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            The system is built around the idea that structured records create
            institutional memory. When every action has a clear record and
            owner, farms can learn from their own history, reduce repeated
            mistakes, and improve operations incrementally.
          </p>
        </div>
      </section>

      <Separator />

      {/* Structured records explanation */}
      <section className="py-16 px-6 bg-background">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <ClipboardList className="h-6 w-6 text-green-600 flex-shrink-0" />
            <h2 className="text-2xl font-semibold">
              How structured records work
            </h2>
          </div>
          <p className="text-muted-foreground leading-relaxed mb-8">
            Everything in Centripetal ES is organized around three building
            blocks that accumulate over time:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assets</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Tools, parts, and physical resources tracked by location,
                  condition, and custody. Assets have a history — every
                  checkout, return, and issue is recorded.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Observations</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Field notes, measurements, and findings captured as
                  structured data. Observations can be reviewed, shared across
                  the team, and promoted into organizational policy.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actions</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Work activities documented with photos, descriptions, and
                  accountability scores. Actions are linked to assets and
                  observations so context is never lost.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <Separator />

      {/* Real-world deployment context */}
      <section className="py-16 px-6 bg-muted/40">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <Tractor className="h-6 w-6 text-green-600 flex-shrink-0" />
            <h2 className="text-2xl font-semibold">
              Grounded in real farm usage
            </h2>
          </div>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Centripetal ES is actively deployed at Stargazer Farm, where it
            manages hundreds of tools and parts, tracks daily work activities,
            and supports a team of farmers and technicians in the field.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            The system was designed from the ground up around the realities of
            farm operations — intermittent connectivity, mobile-first usage,
            and the need for records that are simple enough to maintain
            consistently. Placeholder for additional deployment context and
            case study details.
          </p>
        </div>
      </section>
    </div>
  );
}
