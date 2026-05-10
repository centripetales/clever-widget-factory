import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Mail, Users } from "lucide-react";

export default function Contact() {
  return (
    <div className="flex flex-col">
      {/* Page header */}
      <section className="bg-muted/40 py-14 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Contact
          </h1>
          <p className="text-muted-foreground text-base sm:text-lg">
            Reach out to learn more about Centripetal ES or to discuss a
            collaboration.
          </p>
        </div>
      </section>

      {/* Contact information + collaboration inquiry */}
      <section className="py-16 px-6 bg-background">
        <div className="max-w-3xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-8">
          {/* Contact information */}
          <Card>
            <CardHeader>
              <Mail className="h-6 w-6 text-green-600 mb-1" />
              <CardTitle>Contact information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Placeholder for contact details — email address, phone number,
                and physical address will be added here.
              </p>
              <Separator />
              <p className="italic">
                Email: contact@centripetales.com (placeholder)
              </p>
              <p className="italic">Location: Placeholder location</p>
            </CardContent>
          </Card>

          {/* Collaboration inquiry */}
          <Card>
            <CardHeader>
              <Users className="h-6 w-6 text-green-600 mb-1" />
              <CardTitle>Collaboration inquiry</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Interested in deploying Centripetal ES at your farm or
                organization? We work with farms, agricultural training
                institutions, and development organizations.
              </p>
              <Separator />
              <p>
                Placeholder for collaboration inquiry form or instructions.
                A contact form or intake process will be added here.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
