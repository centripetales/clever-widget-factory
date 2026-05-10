import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, BarChart3, Leaf, MapPin, Sprout } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="bg-gradient-to-b from-green-50 to-background py-20 px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Structured records for the working farm
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground mb-8">
            Centripetal ES organizes your assets, observations, and actions over
            time — so nothing gets lost and everything is accountable.
          </p>
          <Button size="lg" asChild>
            <Link to="/contact">
              Get in touch <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* System explanation */}
      <section className="py-16 px-6 bg-background">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold mb-4">
            What is Centripetal ES?
          </h2>
          <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
            Centripetal ES is an agricultural management system that brings
            structure to everyday farm operations. It tracks tools, parts, and
            work activities — linking observations to actions and actions to
            outcomes — so farms can learn from their own history and improve
            over time.
          </p>
        </div>
      </section>

      {/* Farmer benefits */}
      <section className="py-16 px-6 bg-muted/40">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
            Built for farmers, grounded in real use
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card>
              <CardHeader>
                <Sprout className="h-8 w-8 text-green-600 mb-2" />
                <CardTitle className="text-base">Asset accountability</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Know where every tool and part is, who has it, and when it
                  was last used — without spreadsheets.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <Leaf className="h-8 w-8 text-green-600 mb-2" />
                <CardTitle className="text-base">Observation records</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Capture field observations as structured data that can be
                  reviewed, shared, and promoted into farm policy.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <BarChart3 className="h-8 w-8 text-green-600 mb-2" />
                <CardTitle className="text-base">Action tracking</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Document work activities with photos and descriptions so
                  every action has a clear record and owner.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Live insights */}
      <section className="py-16 px-6 bg-background">
        <div className="max-w-3xl mx-auto text-center">
          <MapPin className="h-10 w-10 text-green-600 mx-auto mb-4" />
          <h2 className="text-2xl sm:text-3xl font-semibold mb-4">
            Live insights — coming soon
          </h2>
          <p className="text-muted-foreground text-base sm:text-lg">
            Real-time data from active farm deployments will appear here.
            Placeholder for live metrics, recent activity, and field status.
          </p>
        </div>
      </section>

      {/* Navigation CTA */}
      <section className="py-16 px-6 bg-muted/40">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-xl sm:text-2xl font-semibold mb-6">
            Learn more or get in touch
          </h2>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button variant="outline" size="lg" asChild>
              <Link to="/about">About the system</Link>
            </Button>
            <Button size="lg" asChild>
              <Link to="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
